//! Compiled regex statics + level maps for `idevicesyslog` (iOS) and
//! `adb logcat` (Android) output.

use once_cell::sync::Lazy;
use regex::Regex;

/// Matches a single line of `idevicesyslog --no-colors` output.
///
/// Format: `<timestamp> <process>[(<subsystem>)][<pid>] [<level>]: <msg>`.
/// Groups: 1=timestamp ("Apr 28 14:14:39.097636"), 2=process name (allows
/// spaces, e.g. "Bragi AI Dev"), 3=subsystem (optional, e.g.
/// "com.brai.bragiai.dev"), 4=pid, 5=level (optional), 6=message.
pub static IOS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.+?)(?:\(([^)]*)\))?\[(\d+)\](?:\s*<(\w+)>)?:\s*(.*)$",
    )
    .expect("IOS_RE compiles")
});

/// Matches a single line of `adb logcat -v year,threadtime` output.
///
/// Format: `<YYYY-MM-DD HH:MM:SS.mmm> <pid> <tid> <V|D|I|W|E|A> <tag>: <msg>`.
/// Groups: 1=ts, 2=pid, 3=tid, 4=lvl-char, 5=tag, 6=message.
pub static ANDROID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEA])\s+(.*?)\s*:\s*(.*)$")
        .expect("ANDROID_RE compiles")
});

/// Strips ANSI escape sequences (CSI / single-char escapes) from log text
/// before regex matching, so colorized device output parses cleanly.
pub static ANSI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])").expect("ANSI_RE compiles"));

/// Map an iOS log level token (Default/Info/Notice/Debug/Warning/Error/
/// Critical/Fault) to the canonical level used by the viewer.
pub fn ios_level(raw: Option<&str>) -> &'static str {
    match raw.unwrap_or("Default") {
        "Default" | "Info" | "Notice" => "INFO",
        "Debug" => "DEBUG",
        "Warning" => "WARN",
        "Error" | "Critical" => "ERROR",
        "Fault" => "ASSERT",
        _ => "INFO",
    }
}

/// Map an Android logcat priority char (V/D/I/W/E/A) to the canonical
/// level used by the viewer.
pub fn android_level(c: char) -> &'static str {
    match c {
        'V' => "VERBOSE",
        'D' => "DEBUG",
        'I' => "INFO",
        'W' => "WARN",
        'E' => "ERROR",
        'A' => "ASSERT",
        _ => "VERBOSE",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ios_re_simple() {
        let line = "Apr 28 14:54:09.315642 wifid(libxpc.dylib)[55] <Debug>: msg here";
        let c = IOS_RE.captures(line).expect("match");
        assert_eq!(&c[1], "Apr 28 14:54:09.315642");
        assert_eq!(&c[2], "wifid");
        assert_eq!(&c[3], "libxpc.dylib");
        assert_eq!(&c[4], "55");
        assert_eq!(&c[5], "Debug");
        assert_eq!(&c[6], "msg here");
    }

    #[test]
    fn ios_re_no_subsystem() {
        let line = "Apr 28 14:54:09.371285 kernel[0] <Notice>: kernel msg";
        let c = IOS_RE.captures(line).expect("match");
        assert_eq!(&c[2], "kernel");
        assert_eq!(c.get(3), None);
        assert_eq!(&c[4], "0");
    }

    #[test]
    fn ios_re_spaced_process() {
        let line =
            "Apr 28 15:00:00.000000 Bragi AI Dev(com.brai.bragiai.dev)[1234] <Info>: app log";
        let c = IOS_RE.captures(line).expect("match");
        assert_eq!(&c[2], "Bragi AI Dev");
        assert_eq!(&c[3], "com.brai.bragiai.dev");
        assert_eq!(&c[4], "1234");
    }

    #[test]
    fn ios_re_spaced_no_subsystem() {
        let line = "Apr 28 15:00:00.000000 Bragi AI Stg[7777] <Notice>: spaced process";
        let c = IOS_RE.captures(line).expect("match");
        assert_eq!(&c[2], "Bragi AI Stg");
        assert_eq!(c.get(3), None);
        assert_eq!(&c[4], "7777");
    }

    #[test]
    fn android_re_basic() {
        let line = "2026-04-28 15:55:28.776  5579 29323 I NearbySharing: Network state changed";
        let c = ANDROID_RE.captures(line).expect("match");
        assert_eq!(&c[1], "2026-04-28 15:55:28.776");
        assert_eq!(&c[2], "5579");
        assert_eq!(&c[3], "29323");
        assert_eq!(&c[4], "I");
        assert_eq!(&c[5], "NearbySharing");
        assert_eq!(&c[6], "Network state changed");
    }

    #[test]
    fn ansi_strips() {
        let stripped = ANSI_RE.replace_all("\x1b[31mred\x1b[0m text", "");
        assert_eq!(stripped, "red text");
    }
}
