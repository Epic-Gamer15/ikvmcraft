import encodeQR from "qr";
import { client } from "./net";

const CLIENT_ID = "c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb";

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface OAuthResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
	refresh_token: string;
}

interface AuthErrorResponse {
	error?: string;
	error_description?: string;
	errorMessage?: string;
	Message?: string;
	XErr?: number;
}

function authErrorMessage(json: AuthErrorResponse): string {
	if (json.XErr) {
		switch (json.XErr) {
			case 2148916227:
				return "xsts says this account is banned from xbox";
			case 2148916233:
				return "xsts says this account does not have a xbox account";
			case 2148916235:
				return "xsts says xbox live is not available in this account's country";
			case 2148916236:
			case 2148916237:
				return "xsts says this account needs adult verification";
			case 2148916238:
				return "xsts says this account is under 18 and needs to be added to a family";
			default:
				return `xsts error: ${json.XErr}`;
		}
	}
	return [json.error, json.error_description, json.errorMessage, json.Message]
		.filter((message) => typeof message === "string" && message.length > 0)
		.join(": ");
}

async function authRequest<T>(
	context: string,
	url: string,
	options?: RequestInit,
	allowedErrors: readonly string[] = []
): Promise<T> {
	let res: Response;
	try {
		res = await client.fetch(url, options);
	} catch (error) {
		throw new Error(
			`${context} failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}

	const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
	let json: unknown;
	try {
		json = await res.json();
	} catch (error) {
		throw new Error(`${context} failed (${status}): invalid JSON response.`, {
			cause: error,
		});
	}
	if (!json || typeof json !== "object" || Array.isArray(json)) {
		throw new Error(`${context} failed (${status}): invalid response.`);
	}

	const data = json as AuthErrorResponse;
	// Device-code polling uses HTTP 400 while waiting for the user to sign in.
	const allowedError = (res.ok || res.status === 400)
		&& typeof data.error === "string" && allowedErrors.includes(data.error);
	if ((!res.ok || data.error || data.XErr) && !allowedError) {
		const message = authErrorMessage(data);
		throw new Error(`${context} failed (${status})${message ? `: ${message}` : "."}`);
	}
	return json as T;
}

export interface Token {
	access: string;
	expires: number;
	refresh: string;
}

interface DeviceCodeResult {
	url: string;
	code: string;
	token: Promise<Token>;
}

function convertOAuthResponse(res: OAuthResponse): Token {
	if (
		typeof res.access_token !== "string" || !res.access_token
		|| typeof res.refresh_token !== "string" || !res.refresh_token
		|| !Number.isFinite(res.expires_in) || res.expires_in <= 0
	) {
		throw new Error("Microsoft authentication returned incomplete token information.");
	}
	return {
		access: res.access_token,
		refresh: res.refresh_token,
		expires: Date.now() + res.expires_in * 1000,
	};
}

export async function deviceCodeAuth(): Promise<DeviceCodeResult> {
	const deviceCodeData = await authRequest<DeviceCodeResponse>(
		"Microsoft device code request",
		"https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				scope: "XboxLive.signin offline_access",
			}).toString(),
		}
	);

	const { device_code, user_code, verification_uri, interval } = deviceCodeData;

	if (!device_code || !user_code || !verification_uri || !Number.isFinite(interval) || interval <= 0) {
		throw new Error("Failed to obtain device code information.");
	}
	const tokenGenerator = async () => {
		// poll the token endpoint until the user completes the authentication
		let tokenData: OAuthResponse | null = null;

		interface TokenPollingResponse {
			access_token?: string;
			error?: string;
		}

		while (!tokenData?.access_token) {
			const pollingResponse = await authRequest<TokenPollingResponse>(
				"Microsoft token polling",
				"https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: CLIENT_ID,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						device_code: device_code,
					}).toString(),
				},
				["authorization_pending"]
			);

			if (pollingResponse.access_token) {
				tokenData = pollingResponse as OAuthResponse;
			} else if (pollingResponse.error === "authorization_pending") {
				// user has not completed the authentication yet; wait for the interval
				await new Promise((resolve) => setTimeout(resolve, interval * 1000));
			} else {
				throw new Error("Microsoft token polling did not return a token.");
			}
		}

		return convertOAuthResponse(tokenData);
	};
	return { url: verification_uri, code: user_code, token: tokenGenerator() };
}

export async function refreshToken(refresh: string): Promise<Token> {
	const json = await authRequest<OAuthResponse>(
		"Microsoft token refresh",
		"https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				grant_type: "refresh_token",
				refresh_token: refresh,
			}),
		}
	);
	return convertOAuthResponse(json);
}

type AuthCodeResult = DeviceCodeResult & {
	link_url: string;
	qr_svg: string;
	qr_svg_uri: string;
};

export async function startDeviceCodeAuth(): Promise<AuthCodeResult> {
	const codeGenerator = await deviceCodeAuth();
	const linkUrl = "https://microsoft.com/link?otc=" + codeGenerator.code;
	const qrSvg = encodeQR(linkUrl, "svg", {
		scale: 6,
		border: 1,
	});
	return {
		...codeGenerator,
		link_url: linkUrl,
		qr_svg: qrSvg,
		qr_svg_uri: `data:image/svg+xml;base64,${btoa(qrSvg)}`,
	};
}

async function xboxAuth(msToken: string): Promise<string> {
	const json = await authRequest<{ Token?: string }>(
		"Xbox Live authentication",
		"https://user.auth.xboxlive.com/user/authenticate",
		{
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			method: "POST",
			body: `{
			"Properties": {
				"AuthMethod": "RPS",
				"SiteName": "user.auth.xboxlive.com",
				"RpsTicket": "d=${msToken}"
			},
			"RelyingParty": "http://auth.xboxlive.com",
			"TokenType": "JWT"
 		}`,
		}
	);
	if (!json["Token"]) throw new Error("xbox live did not return a token");

	return json["Token"];
}

async function xstsAuth(
	xboxToken: string
): Promise<{ token: string; userHash: string }> {
	const json = await authRequest<{
		Token?: string;
		DisplayClaims?: { xui?: { uhs?: string }[] };
	}>(
		"XSTS authorization",
		"https://xsts.auth.xboxlive.com/xsts/authorize",
		{
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			method: "POST",
			body: JSON.stringify({
				Properties: {
					SandboxId: "RETAIL",
					UserTokens: [xboxToken],
				},
				RelyingParty: "rp://api.minecraftservices.com/",
				TokenType: "JWT",
			}),
		}
	);

	const token = json["Token"];
	if (!token) throw new Error("xsts did not return a token");
	const userHash = json.DisplayClaims?.xui?.[0]?.uhs;
	if (!userHash) throw new Error("xsts did not return user hash");

	return { token, userHash };
}

async function mcAuth(xstsToken: string, xstsHash: string): Promise<string> {
	const json = await authRequest<{ access_token?: string }>(
		"Minecraft authentication",
		"https://api.minecraftservices.com/authentication/login_with_xbox",
		{
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			method: "POST",
			body: JSON.stringify({
				identityToken: `XBL3.0 x=${xstsHash};${xstsToken}`,
			}),
		}
	);
	const token = json["access_token"];
	if (!token) throw new Error("minecraft did not return a token");

	if (!(await checkOwnership(token))) throw new Error("account does not own minecraft");

	return token;
}

export async function checkOwnership(mcToken: string): Promise<boolean> {
	const json = await authRequest<{ items?: { name: string }[] }>(
		"Minecraft ownership check",
		"https://api.minecraftservices.com/entitlements/mcstore",
		{
			headers: {
				Authorization: `Bearer ${mcToken}`,
			},
		}
	);
	if (!Array.isArray(json.items)) {
		throw new Error("Minecraft ownership check did not return entitlements.");
	}
	return json.items.some(
		(item) => item.name === "product_minecraft" || item.name === "game_minecraft"
	);
}

// https://gist.github.com/Plagiatus/ce5f18bc010395fc45d8553905e10f55
export interface UserInfo {
	id: string;
	name: string;
	skins: SkinInfo[];
	capes: CapeInfo[];
}
export interface AccessoryInfo {
	id: string;
	state: "ACTIVE" | "INACTIVE";
	url: string;
}
export interface SkinInfo extends AccessoryInfo {
	variant: string;
}
export interface CapeInfo extends AccessoryInfo {
	alias: string;
}

export async function getProfile(mcToken: string): Promise<UserInfo> {
	const json = await authRequest<UserInfo>(
		"Minecraft profile request",
		"https://api.minecraftservices.com/minecraft/profile",
		{
			headers: {
				Authorization: `Bearer ${mcToken}`,
			},
		}
	);
	if (!json["id"] || !json["name"])
		throw new Error("mc did not return a profile");

	return json;
}

export async function minecraftAuth(msToken: string): Promise<string> {
	const xboxToken = await xboxAuth(msToken);
	const xstsInfo = await xstsAuth(xboxToken);
	return mcAuth(xstsInfo.token, xstsInfo.userHash);
}
