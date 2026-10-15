import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Loading } from './components/ui';

const Home = lazy(() => import('./pages/Home'));
const LiveMonitoring = lazy(() => import('./pages/LiveMonitoring'));
const Batches = lazy(() => import('./pages/Batches'));
const BatchDetail = lazy(() => import('./pages/BatchDetail'));
const GrowthTimeline = lazy(() => import('./pages/GrowthTimeline'));
const Predictions = lazy(() => import('./pages/Predictions'));
const Control = lazy(() => import('./pages/Control'));
const Assistant = lazy(() => import('./pages/Assistant'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Devices = lazy(() => import('./pages/Devices'));
const SettingsPage = lazy(() => import('./pages/Settings'));

export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<Loading label="Loading page…" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/monitoring" element={<LiveMonitoring />} />
          <Route path="/batches" element={<Batches />} />
          <Route path="/batches/:id" element={<BatchDetail />} />
          <Route path="/timeline" element={<GrowthTimeline />} />
          <Route path="/timeline/:id" element={<GrowthTimeline />} />
          <Route path="/predictions" element={<Predictions />} />
          <Route path="/control" element={<Control />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
