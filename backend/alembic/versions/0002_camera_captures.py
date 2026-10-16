"""camera captures (ESP32-CAM phase recognition)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-16 16:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'camera_captures',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('camera_device_id', sa.String(length=64), nullable=True),
        sa.Column('target_device_id', sa.String(length=64), nullable=True),
        sa.Column('captured_at', sa.DateTime(), nullable=False),
        sa.Column('source', sa.String(length=16), nullable=False),
        sa.Column('trigger', sa.String(length=16), nullable=False),
        sa.Column('image_path', sa.String(length=256), nullable=False),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('size_bytes', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('method', sa.String(length=16), nullable=True),
        sa.Column('card_key', sa.String(length=64), nullable=True),
        sa.Column('species_key', sa.String(length=32), nullable=True),
        sa.Column('phase_key', sa.String(length=32), nullable=True),
        sa.Column('stage_key', sa.String(length=64), nullable=True),
        sa.Column('confidence', sa.String(length=16), nullable=True),
        sa.Column('inliers', sa.Integer(), nullable=False),
        sa.Column('second_inliers', sa.Integer(), nullable=False),
        sa.Column('qr_text', sa.String(length=128), nullable=True),
        sa.Column('details', sa.JSON(), nullable=True),
        sa.Column('applied', sa.Boolean(), nullable=False),
        sa.Column('applied_at', sa.DateTime(), nullable=True),
        sa.Column('applied_batch_id', sa.Integer(), nullable=True),
        sa.Column('applied_stage_key', sa.String(length=64), nullable=True),
        sa.Column('applied_by', sa.String(length=64), nullable=True),
        sa.Column('apply_note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('camera_captures', schema=None) as batch_op:
        batch_op.create_index('ix_camera_captures_captured', ['captured_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_camera_captures_camera_device_id'), ['camera_device_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('camera_captures', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_camera_captures_camera_device_id'))
        batch_op.drop_index('ix_camera_captures_captured')
    op.drop_table('camera_captures')
