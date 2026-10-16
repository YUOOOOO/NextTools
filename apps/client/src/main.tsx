import React from "react";
import ReactDOM from "react-dom/client";
import { ClientRoot } from "./ClientRoot";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClientRoot />
  </React.StrictMode>,
);
