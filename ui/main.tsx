/** Mounts the dashboard into the page shell the host serves. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { required } from "./invariants.js";

createRoot(required(document.getElementById("root"))).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
