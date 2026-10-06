# BoutiqFlow DZ — Software Supply Chain Security & Dependency Governance

## 1. Overview & Policy
Software supply chain security is a foundational requirement in BoutiqFlow DZ (OWASP Top 10:2025 A03). Any unauthorized modification, compromised dependency, or unvetted transitive package introduces direct operational and multi-tenant security risks.

### Mandatory Supply Chain Rules
1. **Lockfile Enforcement**: Production builds must strictly use `npm ci` with `package-lock.json`. Arbitrary `npm install` during build/deployment is strictly prohibited.
2. **Deterministic Artifacts**: Builds must produce reproducible outputs with verified cryptographic hashes.
3. **Zero Critical Vulnerabilities**: Releases are blocked if dependencies contain unresolved CRITICAL or known exploitable vulnerabilities.
4. **License Compliance**: Commercial deployment strictly prohibits AGPL, SSPL, or viral copyleft licenses that compromise proprietary source code.

---

## 2. Dependency Inventory & Toolchain

### 2.1 Core Runtime Stack
- **Runtime Environment**: Node.js LTS (v20+ / v22+)
- **Database Engine**: PostgreSQL 16.15+ / 17.11+ (patched against CVE-2026-14666 RLS caching vulnerability)
- **Package Manager**: npm v10+ with signed registry validation
- **Lockfile Format**: Version 3 (`package-lock.json`)

### 2.2 Direct Production Dependencies
| Package | Version | Purpose | License | Security Status |
|---|---|---|---|---|
| `crypto` | Built-in | Cryptographic primitives (AES-256-GCM, SHA-256, HMAC) | Node.js | Clean |
| `fs` / `path` | Built-in | Filesystem persistence & stream processing | Node.js | Clean |
| `http` / `https` | Built-in | Networking & outbound integrations | Node.js | Clean |

*(Note: BoutiqFlow Core utilizes a zero-external-bloat runtime design, minimizing third-party attack surfaces and eliminating transitive dependency risks.)*

### 2.3 Software Bill of Materials (SBOM) Specification
BoutiqFlow generates an industry-standard CycloneDX and SPDX compatible SBOM located at:
- `security/sbom.json`

The SBOM documents:
- Authoritative package names, versions, and hashes
- Author and repository source URLs
- Direct and transitive dependency graphs
- Verified open-source licenses

---

## 3. Continuous Supply Chain Verification (CI/CD Gates)
The CI/CD pipeline enforces the following automated security checks prior to every deployment:

1. **Dependency Audit**: Automated scan against the GitHub Advisory Database and CVE feeds.
2. **Secret Scanning**: Regex and entropy-based inspection of git history and staged commits for credentials, API tokens, and private keys.
3. **Static Application Security Testing (SAST)**: AST analysis for prototype pollution, insecure regexes, and fail-open conditionals.
4. **Software Integrity Verification**: Hash comparison of all staged scripts against baseline signatures.
