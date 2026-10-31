const { useMemo, useState } = React;

const availableNodes = [
  { id: "fxy-jp", provider: "fxy", name: "[GPT][IPv6] 日本hy13", delay: 401 },
  { id: "cdpc-us-west", provider: "cdpc", name: "美国西部BGP网关 (IPv6 Only)", delay: 912 },
  { id: "cdpc-ca", provider: "cdpc", name: "深圳加拿大IPLC专用网 (精品网) - TAP", delay: 2183 },
  { id: "cdpc-us", provider: "cdpc", name: "深圳美国IPLC专用网 (精品网) - TAP", delay: 3696 }
];

const initialProviders = [
  { id: "fxy", type: "HTTP", nodes: 3, passed: 1, quota: "274 GB / 300 GB", detail: "预计 5 天后用完 · 8 个月后到期", ratio: 91 },
  { id: "fxy-legacy", type: "本地", nodes: 9, passed: null, quota: "无额度信息", detail: "16 天前更新", ratio: null },
  { id: "cdpc", type: "本地", nodes: 16, passed: 3, quota: "无额度信息", detail: "13 分钟前同步", ratio: null }
];

function App() {
  const [tab, setTab] = useState("routes");
  const [nodes, setNodes] = useState(availableNodes);
  const [current, setCurrent] = useState("fxy-jp");
  const [automatic, setAutomatic] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [providers, setProviders] = useState(initialProviders);
  const currentNode = useMemo(() => nodes.find((node) => node.id === current) || nodes[0], [nodes, current]);

  function scan() {
    if (scanning) return;
    setScanning(true);
    window.setTimeout(() => {
      setNodes(availableNodes.map((node, index) => ({ ...node, delay: node.delay + [12, -18, 24, -31][index] })));
      setScanning(false);
    }, 1200);
  }

  function useNode(id) {
    setCurrent(id);
    setAutomatic(false);
  }

  function refreshProvider(id) {
    setProviders((items) => items.map((item) => item.id === id ? { ...item, detail: "刚刚更新" } : item));
  }

  return (
    <main className="panel" data-screen-label="Clash 统一控制中心">
      <header className="header">
        <div className="mark" aria-hidden="true"></div>
        <div className="title">Clash Verge</div>
        <div className="live">运行中</div>
        <button className="text-button" onClick={() => setTab("subscriptions")}>管理</button>
      </header>

      <section className="hero" aria-label="当前 ChatGPT 路由">
        <div className="eyebrow">CHATGPT 当前线路</div>
        <div className="route-line">
          <div>
            <div className="route-name"><span>●</span>{currentNode.name}</div>
            <div className="route-meta">订阅 {currentNode.provider} · {automatic ? "自动选择" : "手动固定"} · {currentNode.delay} ms</div>
          </div>
          <div className="route-state">可用</div>
        </div>
        <div className="actions">
          <button className="button primary" onClick={scan} disabled={scanning}>
            {scanning ? <><span className="spinner"></span> 检测中</> : "检测全部线路"}
          </button>
          <button className="button" onClick={() => setAutomatic(true)} disabled={automatic}>恢复自动选择</button>
        </div>
      </section>

      <nav className="tabs" aria-label="主视图">
        <button className={`tab ${tab === "routes" ? "active" : ""}`} onClick={() => setTab("routes")}>ChatGPT 节点 <span className="tab-count">{nodes.length}</span></button>
        <button className={`tab ${tab === "subscriptions" ? "active" : ""}`} onClick={() => setTab("subscriptions")}>订阅 <span className="tab-count">{providers.length}</span></button>
      </nav>

      {tab === "routes" ? (
        <section aria-label="可用节点">
          <div className="scan-line">
            <div className="scan-summary"><strong>{nodes.length}</strong> 条线路通过 OpenAI 检测</div>
            <button className="text-button" onClick={scan}>{scanning ? "检测中…" : "重新检测"}</button>
          </div>
          <div className="section-note">已聚合全部订阅，只展示能够访问 ChatGPT 的节点。</div>
          <div className="node-list">
            {nodes.map((node) => (
              <article className={`node ${current === node.id ? "using" : ""}`} key={node.id}>
                <div className="node-main">
                  <span className="dot" aria-hidden="true"></span>
                  <div className="node-copy">
                    <div className="node-name">{node.name}</div>
                    <div className="node-sub">来自 {node.provider}</div>
                  </div>
                  <div className="latency">{node.delay} ms</div>
                  <button className="text-button use" onClick={() => useNode(node.id)} disabled={current === node.id}>{current === node.id ? "使用中" : "使用"}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section aria-label="订阅管理">
          <div className="scan-line">
            <div className="scan-summary">统一管理节点来源、额度和刷新状态</div>
            <button className="text-button" onClick={() => providers.forEach((provider) => refreshProvider(provider.id))}>全部刷新</button>
          </div>
          <div className="provider-list">
            {providers.map((provider) => (
              <article className="provider" key={provider.id}>
                <div className="provider-head">
                  <div className="provider-name">{provider.id}</div>
                  <div className="provider-type">{provider.type}</div>
                  <button className="text-button" onClick={() => refreshProvider(provider.id)}>{provider.type === "HTTP" ? "刷新" : "同步"}</button>
                </div>
                <div className="provider-stats">
                  <span>ChatGPT 可用</span><strong>{provider.passed == null ? "未检测" : `${provider.passed} / ${provider.nodes}`}</strong>
                  <span>{provider.quota}</span><span>{provider.detail}</span>
                </div>
                {provider.ratio != null && <div className="quota"><span style={{ width: `${provider.ratio}%` }}></span></div>}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="advanced">
        <button className="advanced-head" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
          <span>高级网络</span><span>{advanced ? "收起" : "展开"}</span>
        </button>
        {advanced && (
          <div className="advanced-body">
            <div className="setting"><span>策略组</span><strong>OPENAI · Fallback</strong></div>
            <div className="setting"><span>运行模式</span><strong>Rule-based</strong></div>
            <div className="setting"><span>TUN</span><strong>关闭</strong></div>
            <div className="setting"><span>普通节点</span><strong>25 个</strong></div>
          </div>
        )}
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
