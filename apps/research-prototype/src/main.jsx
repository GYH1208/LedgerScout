import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { LiveApp } from "./LiveApp.jsx";
import EquityApp from "./EquityApp.jsx";
import "./styles.css";

function LiveWorkspace() {
  const [domain,setDomain]=React.useState(()=>new URLSearchParams(location.search).get('domain')==='us-equity'?'us-equity':'ethereum');
  function select(next){const url=new URL(location.href);url.searchParams.set('domain',next);history.replaceState(null,'',url);setDomain(next);}
  return domain==='us-equity'?<EquityApp onEthereum={()=>select('ethereum')}/>:<LiveApp onEquity={()=>select('us-equity')}/>;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get("mode") === "live" ? (
      <LiveWorkspace />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
