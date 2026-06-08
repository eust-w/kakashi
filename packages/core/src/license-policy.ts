const PERMISSIVE = new Set(["MIT", "APACHE-2.0", "BSD-2-CLAUSE", "BSD-3-CLAUSE", "ISC", "0BSD"]);

const COPYLEFT = new Set([
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "MPL-2.0",
  "EPL-2.0"
]);

export function isAllowedLicense(spdxId: string | null, allowCopyleft: boolean): boolean {
  if (!spdxId || spdxId === "NOASSERTION") return false;
  const normalized = spdxId.toUpperCase();
  if (PERMISSIVE.has(normalized)) return true;
  return allowCopyleft && COPYLEFT.has(normalized);
}

export function describeLicensePolicy(allowCopyleft: boolean): string {
  return allowCopyleft
    ? "permissive and copyleft repositories with declared SPDX licenses"
    : "permissive repositories only (MIT, Apache-2.0, BSD, ISC, 0BSD)";
}

