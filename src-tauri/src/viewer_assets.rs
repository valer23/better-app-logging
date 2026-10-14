//! Static viewer assets: every file under `viewer/assets/`, embedded at compile time (like the
//! page itself) and served by `http_server` at `GET /assets/*path`.
//!
//! Lookup is an exact match against [`FILES`], so no request path can reach the filesystem or
//! climb out of the directory. Adding a file means adding one line here; the
//! `assets_match_disk` test fails until the table and the directory agree.

/// One servable file.
#[derive(Debug, Clone, Copy)]
pub struct Asset {
    pub bytes: &'static [u8],
    pub mime: &'static str,
    /// Long-lived browser caching. Only versioned file names (the fonts) get it; CSS and JS keep
    /// `no-store`, because WKWebView and WebView2 disk caches survive app upgrades.
    pub immutable: bool,
}

macro_rules! embed {
    ($($path:literal),* $(,)?) => {
        &[$((
            $path,
            include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../viewer/assets/", $path)) as &'static [u8],
        )),*]
    };
}

/// Paths are relative to `viewer/assets/`, with `/` separators, sorted.
pub static FILES: &[(&str, &[u8])] = embed![
    "css/base.css",
    "css/foundation.css",
    "css/legacy.css",
    "fonts/OFL-atkinson-hyperlegible-mono.txt",
    "fonts/OFL-atkinson-hyperlegible-next.txt",
    "fonts/OFL-geist.txt",
    "fonts/OFL-jetbrains-mono.txt",
    "fonts/atkinson-hyperlegible-mono-5.3.0-latin-ext.woff2",
    "fonts/atkinson-hyperlegible-mono-5.3.0-latin.woff2",
    "fonts/atkinson-hyperlegible-next-5.3.0-latin-ext.woff2",
    "fonts/atkinson-hyperlegible-next-5.3.0-latin.woff2",
    "fonts/fonts.css",
    "fonts/geist-5.3.0-latin-ext.woff2",
    "fonts/geist-5.3.0-latin.woff2",
    "fonts/jetbrains-mono-5.3.0-latin-ext.woff2",
    "fonts/jetbrains-mono-5.3.0-latin.woff2",
    "js/dev-bench.js",
];

/// Files under `viewer/assets/` that are kept in the repo but never served.
#[cfg(test)]
const NOT_SERVED: &[&str] = &["fonts/SHA256SUMS", "fonts/SOURCES.md"];

/// Content type and cache policy by extension; `None` for anything we do not serve.
pub fn mime_for(path: &str) -> Option<(&'static str, bool)> {
    let (_, ext) = path.rsplit_once('.')?;
    match ext {
        "css" => Some(("text/css; charset=utf-8", false)),
        "js" => Some(("text/javascript; charset=utf-8", false)),
        "svg" => Some(("image/svg+xml", false)),
        "woff2" => Some(("font/woff2", true)),
        "txt" => Some(("text/plain; charset=utf-8", false)),
        _ => None,
    }
}

/// Exact-match lookup of a path relative to `viewer/assets/`.
pub fn lookup(path: &str) -> Option<Asset> {
    let (_, bytes) = FILES.iter().find(|(p, _)| *p == path)?;
    let (mime, immutable) = mime_for(path)?;
    Some(Asset {
        bytes,
        mime,
        immutable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::Path;

    fn walk(dir: &Path, prefix: &str, out: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).expect("read viewer/assets") {
            let entry = entry.expect("dir entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let rel = format!("{prefix}{name}");
            if entry.file_type().expect("file type").is_dir() {
                walk(&entry.path(), &format!("{rel}/"), out);
            } else {
                out.insert(rel);
            }
        }
    }

    #[test]
    fn mime_and_cache_policy_per_extension() {
        assert_eq!(
            mime_for("a/b.css"),
            Some(("text/css; charset=utf-8", false))
        );
        assert_eq!(
            mime_for("a/b.js"),
            Some(("text/javascript; charset=utf-8", false))
        );
        assert_eq!(mime_for("a/b.svg"), Some(("image/svg+xml", false)));
        assert_eq!(mime_for("a/b.woff2"), Some(("font/woff2", true)));
        assert_eq!(
            mime_for("a/b.txt"),
            Some(("text/plain; charset=utf-8", false))
        );
        assert_eq!(mime_for("a/b.html"), None);
        assert_eq!(mime_for("SHA256SUMS"), None);
    }

    #[test]
    fn lookup_serves_table_entries() {
        let css = lookup("css/base.css").expect("base.css is embedded");
        assert_eq!(css.mime, "text/css; charset=utf-8");
        assert!(!css.immutable);
        assert!(!css.bytes.is_empty());
    }

    #[test]
    fn lookup_rejects_unknown_and_traversal_paths() {
        for bad in [
            "",
            "css",
            "css/",
            "css/missing.css",
            "../applogs-viewer.html",
            "css/../css/base.css",
            "/css/base.css",
            "css%2Fbase.css",
            "CSS/BASE.CSS",
            "fonts/SOURCES.md",
        ] {
            assert!(lookup(bad).is_none(), "{bad:?} must not resolve");
        }
    }

    #[test]
    fn fonts_are_served_as_immutable_woff2() {
        let font = lookup("fonts/geist-5.3.0-latin.woff2").expect("Geist is embedded");
        assert_eq!(font.mime, "font/woff2");
        assert!(font.immutable);
        let face = lookup("fonts/fonts.css").expect("fonts.css is embedded");
        assert!(!face.immutable);
    }

    #[test]
    fn every_entry_has_a_mime_type() {
        for (path, _) in FILES {
            assert!(mime_for(path).is_some(), "{path} has no MIME type");
        }
    }

    #[test]
    fn assets_match_disk() {
        let mut on_disk = BTreeSet::new();
        walk(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../viewer/assets"),
            "",
            &mut on_disk,
        );
        for skip in NOT_SERVED {
            assert!(
                on_disk.remove(*skip),
                "{skip} is in NOT_SERVED but not on disk"
            );
        }
        let table: BTreeSet<String> = FILES.iter().map(|(p, _)| (*p).to_string()).collect();
        let missing: Vec<_> = on_disk.difference(&table).collect();
        let stale: Vec<_> = table.difference(&on_disk).collect();
        assert!(missing.is_empty(), "add to FILES: {missing:?}");
        assert!(stale.is_empty(), "remove from FILES: {stale:?}");
        let listed: Vec<&str> = FILES.iter().map(|(p, _)| *p).collect();
        let mut sorted = listed.clone();
        sorted.sort_unstable();
        assert_eq!(listed, sorted, "keep FILES sorted");
    }

    #[test]
    fn woff2_files_have_the_woff2_signature() {
        for (path, bytes) in FILES.iter().filter(|(p, _)| p.ends_with(".woff2")) {
            assert_eq!(bytes.get(..4), Some(&b"wOF2"[..]), "{path} is not woff2");
        }
    }

    #[test]
    fn immutable_files_carry_a_version_in_their_name() {
        let is_version = |part: &str| {
            let nums: Vec<&str> = part.split('.').collect();
            nums.len() == 3
                && nums
                    .iter()
                    .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        };
        for (path, _) in FILES {
            if lookup(path).expect("table entry").immutable {
                assert!(
                    path.split(['-', '/']).any(is_version),
                    "{path} is cached as immutable but has no x.y.z version in its name"
                );
            }
        }
    }

    /// Every `assets/...` the page references (src/href) and every `url(...)` in served CSS
    /// resolves to a table entry.
    #[test]
    fn page_and_css_references_resolve() {
        let html = crate::http_server::VIEWER_HTML;
        let mut refs = Vec::new();
        for attr in ["src=\"assets/", "href=\"assets/"] {
            let mut rest = html;
            while let Some(i) = rest.find(attr) {
                rest = &rest[i + attr.len()..];
                let end = rest.find('"').expect("closing quote");
                refs.push(rest[..end].to_string());
            }
        }
        assert!(
            refs.iter().any(|r| r == "css/base.css"),
            "the page links css/base.css: {refs:?}"
        );
        for (path, bytes) in FILES.iter().filter(|(p, _)| p.ends_with(".css")) {
            let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            let css = std::str::from_utf8(bytes).expect("utf-8 css");
            let mut rest = css;
            while let Some(i) = rest.find("url(") {
                rest = &rest[i + 4..];
                let end = rest.find(')').expect("closing paren");
                let target = rest[..end].trim_matches(|c| c == '"' || c == '\'');
                if !target.starts_with("data:") && !target.contains("://") {
                    refs.push(format!("{dir}/{target}"));
                }
            }
        }
        for r in &refs {
            assert!(lookup(r).is_some(), "referenced asset {r} is not served");
        }
    }
}
