from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import ai as ai_pkg  # noqa: F401  (ensures package import)
from ..ai import service as ai_module
from ..core.deps import CurrentUser, get_optional_user, read_access, require_role
from ..db.models import AIConversation, AIMessage, CultivationBatch, Device
from ..db.session import get_db
from ..schemas.api import ChatMessageCreate, ConversationCreate
from ..services.control import active_batch_for_device

router = APIRouter(prefix="/api/ai", tags=["ai"])

SUGGESTED_QUESTIONS = [
    "What is the current temperature?",
    "Is the humidity inside the configured range?",
    "What changed in the last 24 hours?",
    "Why is the heater currently running?",
    "What is the current cultivation stage?",
    "What conditions should I monitor next?",
    "What environmental problems occurred today?",
    "What data is missing?",
    "What should I investigate before the next stage?",
]


def _message_dict(m: AIMessage) -> dict:
    return {"id": m.id, "role": m.role, "content": m.content, "mode": m.mode, "provider": m.provider, "model": m.model,
            "prompt_tokens": m.prompt_tokens, "completion_tokens": m.completion_tokens, "latency_ms": m.latency_ms,
            "context_snapshot": m.context_snapshot, "error": m.error, "created_at": m.created_at.isoformat()}


def _conversation_dict(c: AIConversation, with_messages: bool = False) -> dict:
    d = {"id": c.id, "title": c.title, "device_id": c.device_id, "batch_id": c.batch_id, "created_at": c.created_at.isoformat(),
         "updated_at": c.updated_at.isoformat(), "message_count": len(c.messages)}
    if with_messages:
        d["messages"] = [_message_dict(m) for m in c.messages]
    return d


@router.get("/status")
def status(_=Depends(read_access)):
    return ai_module.ai_service.status()


@router.post("/diagnostics")
async def diagnostics(_: CurrentUser = Depends(require_role("admin"))):
    return await ai_module.ai_service.diagnostics()


@router.get("/suggestions")
def suggestions(_=Depends(read_access)):
    return {"questions": SUGGESTED_QUESTIONS}


@router.get("/conversations")
def list_conversations(_=Depends(read_access), db: Session = Depends(get_db), limit: int = Query(default=30, ge=1, le=200)):
    rows = db.execute(select(AIConversation).order_by(AIConversation.updated_at.desc()).limit(limit)).scalars().unique().all()
    return [_conversation_dict(c) for c in rows]


@router.post("/conversations", status_code=201)
def create_conversation(body: ConversationCreate, user: CurrentUser | None = Depends(get_optional_user), db: Session = Depends(get_db),
                        _=Depends(read_access)):
    device_id = body.device_id
    if device_id and db.get(Device, device_id) is None:
        raise HTTPException(status_code=422, detail="device_id does not exist")
    if body.batch_id and db.get(CultivationBatch, body.batch_id) is None:
        raise HTTPException(status_code=422, detail="batch_id does not exist")
    c = AIConversation(title=body.title or "New conversation", user_id=user.id if user else None, device_id=device_id, batch_id=body.batch_id)
    db.add(c)
    db.commit()
    return _conversation_dict(c, with_messages=True)


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    c = db.get(AIConversation, conversation_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _conversation_dict(c, with_messages=True)


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: int, _: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    c = db.get(AIConversation, conversation_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    db.delete(c)
    db.commit()
    return None


@router.post("/conversations/{conversation_id}/messages", status_code=201)
async def send_message(conversation_id: int, body: ChatMessageCreate, user: CurrentUser | None = Depends(get_optional_user),
                       db: Session = Depends(get_db), _=Depends(read_access)):
    c = db.get(AIConversation, conversation_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    device = db.get(Device, c.device_id) if c.device_id else None
    if device is None:
        device = db.execute(select(Device).where(Device.connection_status == "online").order_by(Device.kind.desc())).scalars().first() \
            or db.execute(select(Device)).scalars().first()
    if device is None:
        raise HTTPException(status_code=409, detail="No device registered")
    batch = db.get(CultivationBatch, c.batch_id) if c.batch_id else active_batch_for_device(db, device.id)
    try:
        reply = await ai_module.ai_service.chat(db, c, body.content, device=device, batch=batch, user_key=user.username if user else "anonymous")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    db.refresh(c)
    return {"conversation": _conversation_dict(c), "messages": [_message_dict(m) for m in c.messages[-2:]], "ai": ai_module.ai_service.status()}
