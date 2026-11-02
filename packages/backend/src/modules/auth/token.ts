/**
 * JWT 认证 —— jose HS256，httpOnly cookie 携带（SSE 同源请求自动带）。
 */

import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { withRuntimeDatabase } from "@/db";
import { appMetadata } from "@/db/schema";
import { env } from "@/env";

export const AUTH_COOKIE = "pi_token";

let secretKey: Uint8Array | null = null;

export function getJwtSecret(): Uint8Array {
	if (secretKey === null) {
		const secret =
			env.jwtSecret ||
			withRuntimeDatabase((db) =>
				db.transaction(() => {
					const key = "jwt_secret";
					db.insert(appMetadata)
						.values({ key, value: crypto.randomUUID() })
						.onConflictDoNothing()
						.run();
					return db.select().from(appMetadata).where(eq(appMetadata.key, key)).get()!.value;
				}),
			);
		secretKey = new TextEncoder().encode(secret);
	}
	return secretKey;
}

export interface AuthUser {
	userId: string;
	username: string;
}

export async function signToken(user: AuthUser): Promise<string> {
	return new SignJWT({ username: user.username })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(user.userId)
		.setIssuedAt()
		.setExpirationTime(`${env.tokenTtlSec}s`)
		.sign(getJwtSecret());
}

export async function verifyToken(token: string): Promise<AuthUser | null> {
	try {
		const { payload } = await jwtVerify(token, getJwtSecret());
		if (typeof payload.sub !== "string" || typeof payload.username !== "string") return null;
		return { userId: payload.sub, username: payload.username };
	} catch {
		return null;
	}
}
