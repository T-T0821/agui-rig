import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// OS の設定に合わせてダークモードにする (shadcn/ui と CopilotKit は .dark クラスで切り替わる)
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
