import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RequireAnon, RequireAuth } from "@/components/auth/RequireAuth";
import { useSessionDirectory } from "@/hooks/useSessionDirectory";
import { ChatPage } from "@/pages/ChatPage";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsPage } from "@/pages/SettingsPage";

export function App() {
	useSessionDirectory();
	return (
		<BrowserRouter>
			<Routes>
				<Route
					path="/login"
					element={
						<RequireAnon>
							<LoginPage />
						</RequireAnon>
					}
				/>
				<Route
					path="/chat"
					element={
						<RequireAuth>
							<ChatPage />
						</RequireAuth>
					}
				/>
				<Route
					path="/settings"
					element={
						<RequireAuth>
							<SettingsPage />
						</RequireAuth>
					}
				/>
				<Route path="*" element={<Navigate to="/chat" replace />} />
			</Routes>
		</BrowserRouter>
	);
}
