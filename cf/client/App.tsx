import { useEffect, useState } from "react";

type HelloResponse = {
  message: string;
  timestamp: string;
};

export default function App(): JSX.Element {
  const [backend, setBackend] = useState<HelloResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/hello")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HelloResponse;
      })
      .then(setBackend)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to fetch backend");
      });
  }, []);

  return (
    <main className="container">
      <h1>Hello World (Frontend TS + React)</h1>
      <p>This is the Cloudflare frontend served from the Worker.</p>

      <section className="card">
        <h2>Backend response</h2>
        {backend ? (
          <>
            <p>
              <strong>{backend.message}</strong>
            </p>
            <small>{backend.timestamp}</small>
          </>
        ) : error ? (
          <p className="error">Backend error: {error}</p>
        ) : (
          <p>Loading /api/hello…</p>
        )}
      </section>
    </main>
  );
}
