import React from "react";
import ReactDOM from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "@fontsource-variable/archivo";
import "@fontsource-variable/ibm-plex-mono";
import "./styles.css";
import App from "./App";
import "./i18n";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
