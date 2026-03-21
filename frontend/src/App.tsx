import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { GlobalModalProvider } from './components/global-modal/GlobalModalProvider';

function App() {
  return (
    <GlobalModalProvider>
      <Router>
        <div className="min-h-screen bg-background text-foreground">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Dashboard />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </Router>
    </GlobalModalProvider>
  );
}

export default App;
