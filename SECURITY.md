# Security Policy

`@electron-internal/extract-zip` is internal to the Electron project. It exists
to extract Electron's own distribution archives — for example the archives
fetched and checksum-verified by [`@electron/get`](https://github.com/electron/get)
— and is consumed only through Electron's own packages.

It is **not** a general-purpose zip extractor. If you need one, use
[`extract-zip`](https://github.com/max-mapper/extract-zip).

## Threat model / Scope

**In scope:** extracting a *validated and trusted* Electron distribution zip — an
archive whose checksum has been verified before extraction, as `@electron/get`
does — when used through one of Electron's own packages.

**Out of scope:**

- Extracting untrusted, attacker-supplied, or otherwise unverified archives.
  Archives that have **not** been checksum-validated (the way `@electron/get`
  validates) are not part of the threat model.
- A reused extraction destination pre-seeded with attacker-controlled contents
  (for example a pre-existing symlink at the destination).

We will only issue GHSAs and accept security bug reports for issues affecting the
in-scope use described above. Reports that depend on extracting
untrusted/unverified archives are outside the threat model and will not be
treated as vulnerabilities in this package.

## Containment guarantees

For in-scope archives, every entry path is verified to land inside `dir`:

- `..` traversal is rejected and absolute paths are stripped, via the `zip` crate's audited `enclosed_name()`.
- Directories are created one component at a time without following symlinks; an entry whose path crosses a symlink is rejected.
- Symlinks are created after all files. Each target is walked against the on-disk tree and the archive's own symlink set, with relative-only hops bounded by `dir` and a hop cap, so a chain resolving outside `dir` is rejected before any link is created.
- NUL bytes and Windows reserved device names (`CON`, `AUX`, `COM1`, trailing space/dot) are rejected on every platform.
- Symlink targets are capped at 4 KiB; per-file output is capped at `max(2 x declared size, 1 MB)` to catch entries that lie about their size.

`test/security.test.js` exercises these escapes end-to-end with hand-crafted archives.

## Reporting a vulnerability

For in-scope reports, please report privately through this repository's **Security**
tab using GitHub's private security advisory workflow. Please do not open a public
issue for suspected vulnerabilities.
