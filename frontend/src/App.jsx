import { useEffect, useState } from 'react';

function App() {
  const [message, setMessage] = useState('Loading...');

  useEffect(() => {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

    fetch(`${apiBaseUrl}/api/hello`)
      .then((res) => res.json())
      .then((data) => setMessage(data.message || 'Backend responded'))
      .catch(() => setMessage('Backend unavailable'));
  }, []);

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>VoxMate PWA</h1>
      <p>{message}</p>
      <p>Frontend работает, backend доступен по /api/hello</p>
    </main>
  );
}

export default App;
