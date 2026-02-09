export default function Home() {
  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
        LivePipe
      </h1>
      <p style={{ color: "#888", marginBottom: "1.5rem" }}>
        Real-time screen content analysis powered by Screenpipe + local AI.
      </p>

      <div
        style={{
          padding: "1.5rem",
          border: "1px solid #333",
          borderRadius: "8px",
          marginBottom: "1.5rem",
          background: "#111",
        }}
      >
        <p style={{ color: "#4ade80", fontSize: "1.125rem", marginBottom: "0.5rem" }}>
          Pipeline Running
        </p>
        <p style={{ color: "#888", fontSize: "0.875rem" }}>
          LivePipe is monitoring your screen and will send notifications for actionable items.
        </p>
      </div>

      <div style={{ color: "#666", fontSize: "0.875rem" }}>
        <h3 style={{ color: "#888", marginBottom: "0.5rem" }}>Manage Services</h3>
        <pre style={{
          background: "#0a0a0a",
          padding: "1rem",
          borderRadius: "6px",
          overflow: "auto"
        }}>
          <code style={{ color: "#888" }}>{`live status    # Check service status
live logs      # View real-time logs
live stop      # Stop all services
live restart   # Restart services`}</code>
        </pre>
      </div>
    </div>
  );
}
