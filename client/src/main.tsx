import { createRoot } from "react-dom/client";
import { installFetchInterceptor } from "./lib/installFetchInterceptor";
import App from "./App";
import "./index.css";

// Guarantee x-project-id on same-origin /api/* requests before any fetch fires.
installFetchInterceptor();

createRoot(document.getElementById("root")!).render(<App />);
