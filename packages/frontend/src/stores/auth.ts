/** auth store —— 当前用户状态，路由守卫用 */

import { create } from "zustand";

interface AuthState {
	username: string | null;
	checked: boolean;
	setUsername: (u: string | null) => void;
	setChecked: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
	username: null,
	checked: false,
	setUsername: (username) => set({ username }),
	setChecked: (checked) => set({ checked }),
}));
