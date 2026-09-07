export type Locale = "th" | "en";

/**
 * User-facing strings the templates render.
 *
 * Kept here rather than as `{{#if}}` branches inside the templates: a locale
 * conditional in six places is six places to forget one. Generated copy is
 * meant to be edited — this only decides what the first draft reads like.
 */
export interface Copy {
  loading: string;
  todo: string;
  genericError: string;
  saveFailed: string;
  signIn: string;
  signInSubtitle: string;
  signingIn: string;
  signInFailed: string;
  signOut: string;
  email: string;
  password: string;
  // commonErrorCatalog values, keyed by the API's machine code.
  common: Record<string, string>;
  auth: Record<string, string>;
}

const th: Copy = {
  loading: "กำลังโหลด…",
  todo: "TODO: ยังไม่มีเนื้อหา",
  genericError: "เกิดข้อผิดพลาด กรุณาลองอีกครั้ง",
  saveFailed: "บันทึกไม่สำเร็จ",
  signIn: "เข้าสู่ระบบ",
  signInSubtitle: "กรอกอีเมลและรหัสผ่านเพื่อเข้าใช้งาน",
  signingIn: "กำลังเข้าสู่ระบบ…",
  signInFailed: "เข้าสู่ระบบไม่สำเร็จ",
  signOut: "ออกจากระบบ",
  email: "อีเมล",
  password: "รหัสผ่าน",
  common: {
    VALIDATION_ERROR: "ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
    UNAUTHORIZED: "กรุณาเข้าสู่ระบบก่อนใช้งาน",
    FORBIDDEN: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้",
    NOT_FOUND: "ไม่พบข้อมูลที่ต้องการ",
    CONFLICT: "ข้อมูลขัดแย้งกับข้อมูลปัจจุบัน กรุณาโหลดใหม่",
    RATE_LIMITED: "ส่งคำขอถี่เกินไป กรุณารอสักครู่",
    INTERNAL: "ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง",
    NETWORK: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่",
    UNKNOWN: "เกิดข้อผิดพลาดที่ไม่รู้จัก กรุณาลองใหม่",
  },
  auth: {
    AUTH_INVALID_CREDENTIALS: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    AUTH_INVALID_TOKEN: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง",
    AUTH_INVALID_PASSWORD: "รหัสผ่านต้องยาว 8–72 ตัวอักษร",
    AUTH_TOO_MANY_ATTEMPTS: "ลองเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่",
    USER_EMAIL_TAKEN: "อีเมลนี้ถูกใช้ไปแล้ว",
    USER_NOT_FOUND: "ไม่พบผู้ใช้",
  },
};

const en: Copy = {
  loading: "Loading…",
  todo: "TODO: nothing here yet",
  genericError: "Something went wrong. Please try again.",
  saveFailed: "Could not save.",
  signIn: "Sign in",
  signInSubtitle: "Enter your email and password to continue.",
  signingIn: "Signing in…",
  signInFailed: "Could not sign in.",
  signOut: "Sign out",
  email: "Email",
  password: "Password",
  common: {
    VALIDATION_ERROR: "Some fields are invalid. Please check and try again.",
    UNAUTHORIZED: "Please sign in to continue.",
    FORBIDDEN: "This account may not use that.",
    NOT_FOUND: "Not found.",
    CONFLICT: "This conflicts with the current data. Please reload.",
    RATE_LIMITED: "Too many requests. Please wait a moment.",
    INTERNAL: "The server had a problem. Please try again.",
    NETWORK: "Cannot reach the server. Check your connection and try again.",
    UNKNOWN: "An unknown error occurred. Please try again.",
  },
  auth: {
    AUTH_INVALID_CREDENTIALS: "Wrong email or password.",
    AUTH_INVALID_TOKEN: "Your session expired. Please sign in again.",
    AUTH_INVALID_PASSWORD: "The password must be 8–72 characters.",
    AUTH_TOO_MANY_ATTEMPTS: "Too many failed attempts. Please wait and try again.",
    USER_EMAIL_TAKEN: "That email is already in use.",
    USER_NOT_FOUND: "User not found.",
  },
};

export function copyFor(locale: Locale): Copy {
  return locale === "en" ? en : th;
}

export function parseLocale(value: string | undefined): Locale | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized !== "th" && normalized !== "en") {
    throw new Error(`unknown --locale ${value} — use "th" or "en"`);
  }
  return normalized;
}

/** Renders a `Record<string, string>` as the body of a TS object literal. */
export function asCatalogEntries(entries: Record<string, string>, indent = "  "): string {
  return Object.entries(entries)
    .map(([code, message]) => `${indent}${code}: ${JSON.stringify(message)},`)
    .join("\n");
}
