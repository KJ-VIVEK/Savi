import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DAYS = "825";

export interface Certificate { ca: string; cert: string; key: string }

/**
 * A certificate for one address, and the authority the phone trusts. The authority is
 * limited to that address and its key is thrown away, so it can never sign anything else.
 */
export async function certificateFor(ip: string, dir: string): Promise<Certificate> {
  const file = join(dir, "certificate.json");
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Certificate;
    const x = new X509Certificate(saved.cert);
    if (x.checkIP(ip) && Date.parse(x.validTo) > Date.now() + 7 * 86_400_000) return saved;
  }
  const made = await create(ip);
  writeFileSync(`${file}.part`, JSON.stringify(made), { mode: 0o600 });
  renameSync(`${file}.part`, file);
  return made;
}

async function create(ip: string): Promise<Certificate> {
  const tmp = mkdtempSync(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "savi-cert-"));
  try {
    const at = (f: string) => join(tmp, f);
    const ssl = (...args: string[]) => run("openssl", args, { timeout: 30_000 });
    writeFileSync(at("ca.cnf"), `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Savi ${ip}
[ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign
subjectKeyIdentifier=hash
nameConstraints=critical,permitted;IP:${ip}/255.255.255.255,permitted;DNS:savi.invalid
`);
    writeFileSync(at("leaf.ext"), `basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=IP:${ip}
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
`);
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
    await ssl("req", "-x509", ...ec, "-config", at("ca.cnf"), "-days", DAYS, "-keyout", at("ca.key"), "-out", at("ca.crt"));
    await ssl("req", "-new", ...ec, "-config", at("ca.cnf"), "-subj", "/CN=Savi server", "-keyout", at("leaf.key"), "-out", at("leaf.csr"));
    await ssl("x509", "-req", "-in", at("leaf.csr"), "-CA", at("ca.crt"), "-CAkey", at("ca.key"), "-days", DAYS, "-extfile", at("leaf.ext"), "-out", at("leaf.crt"));
    const read = (f: string) => readFileSync(at(f), "utf8");
    return { ca: read("ca.crt"), cert: read("leaf.crt"), key: read("leaf.key") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
