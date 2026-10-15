import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { OpeningPage } from './pages/OpeningPage.tsx';
import { SignedInPage } from './pages/SignedInPage.tsx';
import { TutorialPage } from './tutorial/TutorialPage.tsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<OpeningPage />} />
        <Route path="/app" element={<SignedInPage />} />
        <Route path="/tutorial" element={<TutorialPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
