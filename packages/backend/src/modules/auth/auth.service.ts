import { AppError } from "@/core/app-error";
import { type AuthUser, signToken } from "./token";
import { authenticate } from "./users";

export function requireUser(user: AuthUser | null): AuthUser {
	if (!user) throw new AppError("UNAUTHORIZED");
	return user;
}

export async function loginUser(
	username: string,
	password: string,
): Promise<{ username: string; token: string }> {
	const user = await authenticate(username, password);
	if (!user) throw new AppError("UNAUTHORIZED", "用户名或密码错误");
	return { username: user.username, token: await signToken(user) };
}
