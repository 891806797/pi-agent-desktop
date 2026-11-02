import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesktopBoundary } from "./components/DesktopBoundary";
import { initializeTheme } from "./lib/theme";
import "./styles/main.css";

const disposeTheme = initializeTheme();
if (import.meta.hot) import.meta.hot.dispose(disposeTheme);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<DesktopBoundary>
			<App />
		</DesktopBoundary>
	</StrictMode>,
);
