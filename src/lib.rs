#![deny(clippy::all)]
#![deny(unsafe_code)]

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;

use filetime::FileTime;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use unicode_normalization::UnicodeNormalization;
use zip::ZipArchive;

const DEFAULT_DIR_MODE: u32 = 0o755;
const DEFAULT_FILE_MODE: u32 = 0o644;
const MAX_WORKERS: usize = 8;
const WRITE_BUF_MAX: u64 = 256 * 1024;
const WRITE_BUF_MIN: u64 = 8 * 1024;
const MAX_SYMLINK_TARGET: u64 = 4096;
/// Permission bits we honour from the archive — setuid/setgid/sticky are
/// deliberately stripped so a hostile zip can't plant a setuid binary.
const MODE_MASK: u32 = 0o777;

#[napi(object)]
pub struct ExtractOptions {
    /// Destination directory. Must be an absolute path.
    pub dir: String,
}

pub struct ExtractTask {
    zip_path: String,
    dest: PathBuf,
}

#[napi]
impl Task for ExtractTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        run_extract(&self.zip_path, &self.dest)
    }
    fn resolve(&mut self, _env: Env, (): ()) -> Result<()> {
        Ok(())
    }
}

#[napi(ts_return_type = "Promise<void>")]
pub fn extract(zip_path: String, opts: ExtractOptions) -> Result<AsyncTask<ExtractTask>> {
    let dest = PathBuf::from(opts.dir);
    if !dest.is_absolute() {
        return Err(Error::new(
            Status::InvalidArg,
            "opts.dir must be an absolute path",
        ));
    }
    Ok(AsyncTask::new(ExtractTask { zip_path, dest }))
}

type Archive = ZipArchive<BufReader<File>>;

fn open_archive(zip_path: &str) -> Result<Archive> {
    let file = File::open(zip_path)
        .map_err(|e| zerr(format!("failed to open archive '{zip_path}': {e}")))?;
    ZipArchive::new(BufReader::with_capacity(64 * 1024, file))
        .map_err(|e| zerr(format!("failed to read archive '{zip_path}': {e}")))
}

struct PendingFile {
    index: usize,
    out_path: PathBuf,
    mode: u32,
    mtime: Option<FileTime>,
    declared_size: u64,
}

struct PendingSymlink {
    out_path: PathBuf,
    target: String,
}

fn run_extract(zip_path: &str, dest: &Path) -> Result<()> {
    let mut archive = open_archive(zip_path)?;

    fs::create_dir_all(dest).map_err(|e| {
        zerr(format!(
            "failed to create destination '{}': {e}",
            dest.display()
        ))
    })?;
    let dest_canon = dest
        .canonicalize()
        .map_err(|e| zerr(format!("failed to canonicalize destination: {e}")))?;

    // ── Pass 1 (serial): path checks + directory creation ────────────────────
    // Symlinks are NOT created here. Directories are created component-by-
    // component with `ensure_dir_nofollow`, which refuses to traverse a
    // symlink. So when pass 2 opens a queued file path, every intermediate
    // component is a real directory we created (or a pre-existing real
    // directory) — the archive cannot have re-pointed any of them.
    let mut dir_fixups: Vec<(PathBuf, u32, Option<FileTime>)> = Vec::new();
    let mut safe_dirs: HashSet<PathBuf> = HashSet::from([dest_canon.clone()]);
    let mut files: Vec<PendingFile> = Vec::with_capacity(archive.len());
    let mut symlinks: Vec<PendingSymlink> = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| zerr(format!("failed to read entry {i}: {e}")))?;

        let mode = entry.unix_mode().map(|m| m & MODE_MASK);
        let mtime = entry.last_modified().map(dos_to_filetime);

        // `enclosed_name()` is the upstream Zip-Slip defence; we layer NUL +
        // Windows-reserved-name rejection on top.
        let Some(rel) = entry
            .enclosed_name()
            .filter(|p| extra_name_checks(p.as_path()))
        else {
            return Err(zerr(format!(
                "refusing to extract '{}': path escapes destination",
                entry.name()
            )));
        };
        let out_path = dest_canon.join(rel);

        if entry.is_dir() {
            ensure_dir_nofollow(&out_path, &dest_canon, &mut safe_dirs)?;
            dir_fixups.push((out_path, mode.unwrap_or(DEFAULT_DIR_MODE), mtime));
            continue;
        }

        if let Some(parent) = out_path.parent() {
            ensure_dir_nofollow(parent, &dest_canon, &mut safe_dirs)?;
        }

        if entry.is_symlink() {
            symlinks.push(PendingSymlink {
                out_path,
                target: read_symlink_target(&mut entry)?,
            });
            continue;
        }

        files.push(PendingFile {
            index: i,
            out_path,
            mode: mode.unwrap_or(DEFAULT_FILE_MODE),
            mtime,
            declared_size: entry.size(),
        });
    }

    // ── Pass 2 (parallel): regular files ─────────────────────────────────────
    let workers = thread::available_parallelism()
        .map_or(4, std::num::NonZero::get)
        .min(MAX_WORKERS)
        .min(files.len().max(1));

    if workers <= 1 {
        for f in &files {
            write_one(&mut archive, f)?;
        }
    } else {
        drop(archive);
        let next = AtomicUsize::new(0);
        let failed = AtomicBool::new(false);
        let first_err: Mutex<Option<Error>> = Mutex::new(None);
        thread::scope(|s| {
            for _ in 0..workers {
                s.spawn(|| {
                    let mut arch = match open_archive(zip_path) {
                        Ok(a) => a,
                        Err(e) => return record_err(&failed, &first_err, e),
                    };
                    while !failed.load(Ordering::Relaxed) {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= files.len() {
                            break;
                        }
                        if let Err(e) = write_one(&mut arch, &files[i]) {
                            return record_err(&failed, &first_err, e);
                        }
                    }
                });
            }
        });
        if let Some(e) = first_err.into_inner().unwrap() {
            return Err(e);
        }
    }

    // ── Pass 3 (serial): symlinks ────────────────────────────────────────────
    // All real dirs and files now exist; only now do we add symlinks. Each
    // target is resolved with a bounded walk that consults both the on-disk
    // tree *and* the full pending-symlink set, so an in-archive link chain
    // cannot smuggle the resolution outside `dest` regardless of entry order.
    //
    // Two entries whose link paths collide — byte-wise *or* under case-fold +
    // NFC (what APFS/NTFS will conflate) — would let `link_map` and the on-disk
    // state diverge mid-pass; refuse them.
    let mut link_map: HashMap<String, &str> = HashMap::with_capacity(symlinks.len());
    for s in &symlinks {
        if link_map
            .insert(fold_key(&s.out_path), s.target.as_str())
            .is_some()
        {
            return Err(zerr(format!(
                "refusing archive with duplicate symlink entry '{}'",
                s.out_path.display()
            )));
        }
    }
    for s in &symlinks {
        create_symlink(s, &dest_canon, &link_map)?;
    }

    // ── Pass 4 (serial): directory perms/mtimes, deepest first ───────────────
    // Paths recorded here are real directories created by `ensure_dir_nofollow`
    // and cannot have been replaced by a symlink (`remove_file` fails on dirs);
    // we lstat-guard anyway as defence in depth.
    dir_fixups.sort_by_key(|(p, _, _)| std::cmp::Reverse(p.as_os_str().len()));
    for (path, mode, mtime) in dir_fixups {
        if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        set_permissions(&path, mode);
        if let Some(t) = mtime {
            let _ = filetime::set_file_mtime(&path, t);
        }
    }

    Ok(())
}

fn record_err(failed: &AtomicBool, slot: &Mutex<Option<Error>>, e: Error) {
    if !failed.swap(true, Ordering::Relaxed) {
        *slot.lock().unwrap() = Some(e);
    }
}

fn write_one(archive: &mut Archive, f: &PendingFile) -> Result<()> {
    let mut entry = archive
        .by_index(f.index)
        .map_err(|e| zerr(format!("failed to read entry {}: {e}", f.index)))?;
    let out = open_output_file(&f.out_path, f.mode)?;
    let buf_cap = f.declared_size.clamp(WRITE_BUF_MIN, WRITE_BUF_MAX) as usize;
    let out = BufWriter::with_capacity(buf_cap, out);
    // Abort if an entry inflates past its declared size (malformed archive).
    let limit = f
        .declared_size
        .saturating_add(64)
        .saturating_mul(2)
        .max(1024 * 1024);
    let mut w = LimitedWriter {
        inner: out,
        written: 0,
        limit,
    };
    io::copy(&mut entry, &mut w)
        .map_err(|e| zerr(format!("failed to write '{}': {e}", f.out_path.display())))?;
    let fh = w
        .inner
        .into_inner()
        .map_err(|e| zerr(format!("failed to flush '{}': {e}", f.out_path.display())))?;
    // open(2) applies the process umask to the create mode; fchmod the handle so
    // the archive's bits land exactly (matches upstream extract-zip). `f.mode`
    // is already & MODE_MASK from pass 1; re-mask here so the setuid strip is
    // enforced locally regardless of caller.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fh.set_permissions(fs::Permissions::from_mode(f.mode & MODE_MASK));
    }
    if let Some(t) = f.mtime {
        // Set via the open handle: no path re-resolution, no symlink follow.
        let _ = filetime::set_file_handle_times(&fh, None, Some(t));
    }
    Ok(())
}

/// `io::copy` sink that errors once `limit` bytes have been written.
struct LimitedWriter<W: Write> {
    inner: W,
    written: u64,
    limit: u64,
}

impl<W: Write> Write for LimitedWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written.saturating_add(buf.len() as u64) > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                format!(
                    "uncompressed output exceeded {} bytes (zip bomb?)",
                    self.limit
                ),
            ));
        }
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Rejects what `enclosed_name()` doesn't: NUL bytes and Windows reserved
/// device names (so a Unix-authored zip containing `aux` can't bite on Windows).
fn extra_name_checks(p: &Path) -> bool {
    p.components().all(|c| match c {
        Component::Normal(s) => {
            let s = s.to_string_lossy();
            !s.contains('\0') && !is_reserved_windows_name(&s)
        }
        _ => true,
    })
}

fn is_reserved_windows_name(s: &str) -> bool {
    // Windows ignores trailing dots/spaces on path components, so `aux ` and
    // `aux.` both open the AUX device. Strip them before checking.
    let s = s.trim_end_matches([' ', '.']);
    let stem = s.split('.').next().unwrap_or(s);
    const RESERVED3: &[&str] = &["CON", "PRN", "AUX", "NUL"];
    if RESERVED3.iter().any(|r| stem.eq_ignore_ascii_case(r)) {
        return true;
    }
    // COM0–COM9 / LPT0–LPT9, plus the superscript ¹²³ variants Win11 added.
    let mut it = stem.chars();
    let head: [Option<char>; 3] = [it.next(), it.next(), it.next()];
    let prefix_ok = matches!(
        head.map(|c| c.map(|c| c.to_ascii_uppercase())),
        [Some('C'), Some('O'), Some('M')] | [Some('L'), Some('P'), Some('T')]
    );
    prefix_ok
        && matches!(
            (it.next(), it.next()),
            (Some('0'..='9' | '\u{B9}' | '\u{B2}' | '\u{B3}'), None)
        )
}

/// Ensure `path` exists as a chain of *real* directories beneath `dest_canon`.
///
/// Walks the suffix `path - dest_canon` one component at a time and at each
/// step `lstat`s the result: a missing component is `mkdir`ed; an existing
/// real directory is accepted; **anything else (symlink, file) is rejected**.
/// We never `canonicalize` after the fact, so we never create something
/// outside `dest` and only then notice. `path` must be a literal descendant of
/// `dest_canon` — the caller guarantees this via `enclosed_name()`.
fn ensure_dir_nofollow(path: &Path, dest_canon: &Path, cache: &mut HashSet<PathBuf>) -> Result<()> {
    if cache.contains(path) {
        return Ok(());
    }
    let suffix = path.strip_prefix(dest_canon).map_err(|_| {
        zerr(format!(
            "internal: '{}' is not under destination",
            path.display()
        ))
    })?;
    let mut cur = dest_canon.to_path_buf();
    for c in suffix.components() {
        let Component::Normal(name) = c else {
            return Err(zerr(format!(
                "internal: unexpected path component in '{}'",
                path.display()
            )));
        };
        cur.push(name);
        if cache.contains(&cur) {
            continue;
        }
        match fs::symlink_metadata(&cur) {
            Ok(m) if m.is_dir() => {}
            Ok(m) if m.file_type().is_symlink() => {
                return Err(zerr(format!(
                    "refusing to traverse symlink at '{}'",
                    cur.display()
                )));
            }
            Ok(_) => {
                return Err(zerr(format!(
                    "cannot create directory '{}': a file already exists there",
                    cur.display()
                )));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&cur).map_err(|e| {
                    zerr(format!(
                        "failed to create directory '{}': {e}",
                        cur.display()
                    ))
                })?;
            }
            Err(e) => {
                return Err(zerr(format!("failed to stat '{}': {e}", cur.display())));
            }
        }
        cache.insert(cur.clone());
    }
    Ok(())
}

fn open_output_file(path: &Path, mode: u32) -> Result<File> {
    #[cfg(not(unix))]
    let _ = mode;
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    match opts.open(path) {
        Ok(f) => Ok(f),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            // Unlink + O_EXCL retry: never open() through a pre-existing symlink.
            fs::remove_file(path).map_err(|e| {
                zerr(format!(
                    "failed to remove existing '{}': {e}",
                    path.display()
                ))
            })?;
            opts.open(path)
                .map_err(|e| zerr(format!("failed to create '{}': {e}", path.display())))
        }
        Err(e) => Err(zerr(format!("failed to create '{}': {e}", path.display()))),
    }
}

/// Read a symlink entry's target string with a hard size cap so a deflate
/// bomb posing as a symlink can't balloon the heap.
/// Case-fold + NFC-normalise a path for use as a `link_map` key. This is what
/// APFS and NTFS do at lookup time, so two names that the kernel would treat as
/// the same inode produce the same key here. On case-sensitive volumes this is
/// conservative (may follow a hop the FS wouldn't), which only ever causes an
/// extra rejection — never an extra acceptance.
fn fold_key(p: &Path) -> String {
    p.to_string_lossy()
        .nfc()
        .flat_map(char::to_lowercase)
        .collect()
}

fn read_symlink_target(entry: &mut impl Read) -> Result<String> {
    let mut limited = entry.take(MAX_SYMLINK_TARGET);
    let mut target = String::new();
    limited
        .read_to_string(&mut target)
        .map_err(|e| zerr(format!("failed to read symlink target: {e}")))?;
    // If the underlying reader still has bytes, the target was oversized.
    let mut probe = [0u8; 1];
    if limited.into_inner().read(&mut probe).unwrap_or(0) != 0 {
        return Err(zerr(format!(
            "symlink target exceeds {MAX_SYMLINK_TARGET} bytes"
        )));
    }
    Ok(target.trim_end_matches('\0').to_owned())
}

fn create_symlink(
    s: &PendingSymlink,
    dest_canon: &Path,
    link_map: &HashMap<String, &str>,
) -> Result<()> {
    // The link's parent was created by `ensure_dir_nofollow` in pass 1 with no
    // symlink components, and nothing since has been able to replace a real
    // directory with a symlink, so `parent` is its own canonical path.
    let parent = s.out_path.parent().unwrap_or(dest_canon);
    verify_symlink_target(parent, &s.target, dest_canon, link_map).map_err(|why| {
        zerr(format!(
            "refusing to create symlink '{}' -> '{}': {why}",
            s.out_path.display(),
            s.target
        ))
    })?;

    // Replace an existing *non-directory* at the link path. We never remove a
    // directory here, so a real dir created in pass 1 cannot be swapped out.
    if let Ok(m) = fs::symlink_metadata(&s.out_path) {
        if m.is_dir() {
            return Err(zerr(format!(
                "cannot create symlink '{}': a directory already exists there",
                s.out_path.display()
            )));
        }
        fs::remove_file(&s.out_path).map_err(|e| {
            zerr(format!(
                "failed to remove existing '{}': {e}",
                s.out_path.display()
            ))
        })?;
    }
    match make_symlink(&s.target, &s.out_path) {
        Ok(()) => Ok(()),
        // Windows without symlink privilege: skip rather than fail the extract.
        #[cfg(windows)]
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => Ok(()),
        Err(e) => Err(zerr(format!(
            "failed to create symlink '{}': {e}",
            s.out_path.display()
        ))),
    }
}

/// Walk `target` against the link's real parent, refusing to let the resolved
/// path leave `dest_canon` at any step. Intermediate symlinks — whether already
/// on disk or still pending in `link_map` — are followed in-place (so
/// `Versions/Current/Libraries` works when `Current → A`), with each hop
/// subject to the same rules: relative only, never ascend above `dest_canon`,
/// hop count capped. A symlink as the *final* component is left unresolved.
fn verify_symlink_target(
    parent: &Path,
    target: &str,
    dest_canon: &Path,
    link_map: &HashMap<String, &str>,
) -> std::result::Result<(), &'static str> {
    use std::ffi::OsString;
    const MAX_HOPS: u32 = 40;
    const PARENT: &str = "..";

    let target = Path::new(target);
    if target.is_absolute() || target.as_os_str().is_empty() {
        return Err("target is absolute or empty");
    }
    // Stack of remaining components (reverse order so `pop` yields head-first).
    let mut work: Vec<OsString> = Vec::new();
    let push_rel = |work: &mut Vec<OsString>, p: &Path| {
        for c in p.components().rev() {
            match c {
                Component::CurDir => {}
                Component::ParentDir => work.push(PARENT.into()),
                Component::Normal(n) => work.push(n.to_owned()),
                Component::Prefix(_) | Component::RootDir => {
                    return Err("target is absolute or empty");
                }
            }
        }
        Ok(())
    };
    push_rel(&mut work, target)?;

    let mut cur = parent.to_path_buf();
    let mut hops = 0u32;
    while let Some(seg) = work.pop() {
        if seg == PARENT {
            if cur == dest_canon {
                return Err("target escapes destination");
            }
            cur.pop();
            continue;
        }
        cur.push(&seg);
        // Is `cur` a symlink — either pending from this archive, or on disk?
        // The map lookup is fold-keyed so a case/normalisation-mismatched
        // reference still finds the pending hop on APFS/NTFS.
        let hop: Option<PathBuf> = if let Some(t) = link_map.get(&fold_key(&cur)) {
            Some(PathBuf::from(t))
        } else {
            match fs::symlink_metadata(&cur) {
                Ok(m) if m.file_type().is_symlink() => {
                    Some(fs::read_link(&cur).map_err(|_| "target is unreadable")?)
                }
                Ok(_) => None,
                Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                Err(_) => return Err("target is unreadable"),
            }
        };
        if let Some(link) = hop {
            if work.is_empty() {
                break; // final component; its own target is verified separately
            }
            hops += 1;
            if hops > MAX_HOPS {
                return Err("too many levels of symlinks in target");
            }
            cur.pop();
            push_rel(&mut work, &link)?;
        }
    }
    // The loop invariant keeps `cur` under `dest_canon`, but this is the
    // security boundary — keep the check unconditional so a future logic slip
    // in the hop resolver fails closed.
    if cur.starts_with(dest_canon) {
        Ok(())
    } else {
        Err("target escapes destination")
    }
}

#[cfg(unix)]
fn make_symlink(target: &str, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn make_symlink(target: &str, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
        .or_else(|_| std::os::windows::fs::symlink_dir(target, link))
}

#[cfg(unix)]
fn set_permissions(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_permissions(_path: &Path, _mode: u32) {}

fn zerr(msg: String) -> Error {
    Error::new(Status::GenericFailure, msg)
}

/// DOS date/time → unix epoch seconds. DOS timestamps are local-time with no
/// zone; we treat them as UTC (same choice the original `extract-zip` makes).
fn dos_to_filetime(dt: zip::DateTime) -> FileTime {
    // Howard Hinnant's days_from_civil — exact for the proleptic Gregorian
    // calendar; DOS dates are 1980..=2107 so well inside the valid range.
    let (y, m, d) = (
        i64::from(dt.year()),
        i64::from(dt.month()),
        i64::from(dt.day()),
    );
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400
        + i64::from(dt.hour()) * 3_600
        + i64::from(dt.minute()) * 60
        + i64::from(dt.second());
    FileTime::from_unix_time(secs, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_checks_reject_nul() {
        assert!(!extra_name_checks(Path::new("a\0b")));
        assert!(!extra_name_checks(Path::new("dir/a\0b")));
        assert!(extra_name_checks(Path::new("a0b")));
    }

    #[test]
    fn extra_checks_reject_reserved() {
        for bad in [
            "AUX",
            "aux",
            "Con",
            "NUL",
            "prn",
            "COM1",
            "lpt9",
            "com1.txt",
            "AUX.tar.gz",
            "aux ",
            "aux. ",
            "nul.",
            "com0",
            "lpt0",
            "COM\u{B9}",
            "LPT\u{B2}",
        ] {
            assert!(!extra_name_checks(Path::new(bad)), "{bad}");
            assert!(!extra_name_checks(&Path::new("sub").join(bad)), "sub/{bad}");
        }
        for ok in ["com", "com1x", "auxx", "console", "lpt", "lpt10", ".aux"] {
            assert!(extra_name_checks(Path::new(ok)), "{ok}");
        }
    }

    #[test]
    fn extra_checks_pass_unicode() {
        assert!(extra_name_checks(Path::new("ünïcödé/文件/🦀.txt")));
    }

    fn lmap<'a>(pairs: &[(&Path, &'a str)]) -> HashMap<String, &'a str> {
        pairs.iter().map(|(p, t)| (fold_key(p), *t)).collect()
    }

    #[test]
    fn symlink_target_rejects_absolute_and_escape() {
        let dest = Path::new("/d");
        let none = lmap(&[]);
        assert!(verify_symlink_target(dest, "/etc/passwd", dest, &none).is_err());
        assert!(verify_symlink_target(dest, "", dest, &none).is_err());
        assert!(verify_symlink_target(dest, "../x", dest, &none).is_err());
        assert!(verify_symlink_target(&dest.join("a"), "../../x", dest, &none).is_err());
        assert!(verify_symlink_target(&dest.join("a"), "../b", dest, &none).is_ok());
        assert!(verify_symlink_target(dest, "a/b/c", dest, &none).is_ok());
    }

    #[test]
    fn symlink_target_resolves_via_pending_map() {
        let dest = Path::new("/d");
        let back = dest.join("deep").join("back");
        let map = lmap(&[(&back, "..")]);
        // The chain attack: lexically inside, physically outside.
        assert_eq!(
            verify_symlink_target(dest, "deep/back/deep/back/../../x", dest, &map),
            Err("target escapes destination")
        );
        // Same chain with case-mismatched reference must also be caught.
        assert_eq!(
            verify_symlink_target(dest, "deep/BACK/deep/Back/../../x", dest, &map),
            Err("target escapes destination")
        );
        // Legitimate framework-style chain stays inside.
        let cur = dest.join("V").join("Current");
        let map = lmap(&[(&cur, "A")]);
        assert!(verify_symlink_target(dest, "V/Current/Libraries", dest, &map).is_ok());
        // Self-loop hits the hop cap, doesn't hang.
        let l = dest.join("l");
        let map = lmap(&[(&l, "l")]);
        assert_eq!(
            verify_symlink_target(dest, "l/x", dest, &map),
            Err("too many levels of symlinks in target")
        );
    }

    #[test]
    fn dos_date_known_points() {
        let cases = [
            ((1980, 1, 1, 0, 0, 0), 315_532_800),  // DOS epoch
            ((2000, 2, 29, 0, 0, 0), 951_782_400), // leap day
            ((2024, 3, 15, 12, 30, 0), 1_710_505_800),
            ((2100, 2, 28, 23, 59, 58), 4_107_542_398), // not a leap year
            ((2107, 12, 31, 23, 59, 58), 4_354_819_198), // DOS max
        ];
        for ((y, mo, d, h, mi, s), want) in cases {
            let dt = zip::DateTime::from_date_and_time(y, mo, d, h, mi, s).unwrap();
            assert_eq!(dos_to_filetime(dt).unix_seconds(), want, "{y}-{mo}-{d}");
        }
    }

    #[test]
    fn limited_writer_trips() {
        let mut sink = Vec::new();
        let mut w = LimitedWriter {
            inner: &mut sink,
            written: 0,
            limit: 10,
        };
        assert!(w.write_all(&[0u8; 10]).is_ok());
        assert!(w.write_all(&[0u8; 1]).is_err());
        assert_eq!(sink.len(), 10);
    }
}
