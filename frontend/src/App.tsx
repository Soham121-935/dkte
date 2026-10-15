import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Loading } from './components/ui';

const Home = lazy(() => import('./pages/Home'));
const Stats = lazy(() => import('./pages/Stats'));
const Predictions = lazy(() => import('./pages/Predictions'));

/**
 * Three pages only:
 *  - `/`            Overview – live readings, manual control and the MYCO AI assistant
 *  - `/stats`       What happened over the last days/weeks
 *  - `/predictions` Forecasts, stage estimate, unusual events and suggestions
 */
export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<Loading label="Loading page…" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/predictions" element={<Predictions />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
