import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { LiveApp } from "./LiveApp.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get("mode") === "live" ? (
      <LiveApp />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
