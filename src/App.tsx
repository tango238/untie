import { useUntieStore } from "./store";

// 仮画面。UI は次の段で作る。
export default function App() {
  const count = useUntieStore((s) => s.model.elements.length);
  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Untie</h1>
      <p>サンプルの要素数: {count}</p>
    </main>
  );
}
