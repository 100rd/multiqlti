import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { installFetchInterceptor } from "./lib/installFetchInterceptor";
import { AccentProvider } from "./contexts/ThemeContext";
import App from "./App";
import "./index.css";

// Guarantee x-project-id on same-origin /api/* requests before any fetch fires.
installFetchInterceptor();

createRoot(document.getElementById("root")!).render(
  <ThemeProvider
    attribute="class"
    defaultTheme="system"
    enableSystem
    disableTransitionOnChange
  >
    <AccentProvider>
      <App />
    </AccentProvider>
  </ThemeProvider>
);
