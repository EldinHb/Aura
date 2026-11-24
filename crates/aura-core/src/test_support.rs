//! Help for tests that need a process of their own.

/// Set in the child [`in_own_process`] starts, to the test it runs.
const OWN_PROCESS: &str = "AURA_TEST_OWN_PROCESS";

/// Whether to run the test body here: true in a process that runs only the
/// test `name` (`module_path!()` and the function's name, joined by `::`).
/// Otherwise this runs that test alone in a new process of the same test
/// binary, waits for it, fails when it failed, and returns false.
///
/// For tests that measure the whole process, such as its open files: the
/// tests the harness runs on other threads open and close their own
/// meanwhile, which a count of the process's descriptors would include.
pub fn in_own_process(name: &str) -> bool {
    // Test names leave out the crate.
    let name = name.split_once("::").map_or(name, |(_, rest)| rest);
    if std::env::var(OWN_PROCESS).is_ok_and(|v| v == name) {
        return true;
    }
    let exe = std::env::current_exe().expect("the test binary");
    let out = std::process::Command::new(exe)
        .args([name, "--exact", "--nocapture", "--test-threads=1"])
        .env(OWN_PROCESS, name)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("start the test binary again");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success() && stdout.contains("1 passed"),
        "{name}, run in its own process, failed:\n{stdout}\n{stderr}"
    );
    false
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_test_in_its_own_process_does_not_count_the_files_of_others() {
        // Files open in this process meanwhile, as other tests on other
        // threads hold them; never in the child (they close on exec).
        let others: Vec<std::fs::File> = match std::env::var(OWN_PROCESS) {
            Ok(_) => vec![],
            Err(_) => (0..64)
                .map(|_| std::fs::File::open("/dev/null").unwrap())
                .collect(),
        };
        if !in_own_process(concat!(
            module_path!(),
            "::a_test_in_its_own_process_does_not_count_the_files_of_others"
        )) {
            drop(others);
            return;
        }
        let open = std::fs::read_dir("/dev/fd").unwrap().count();
        assert!(open < 64, "{open} descriptors open");
    }

    #[test]
    #[should_panic(expected = "run in its own process, failed")]
    fn a_failure_in_the_own_process_fails_the_test() {
        if in_own_process(concat!(
            module_path!(),
            "::a_failure_in_the_own_process_fails_the_test"
        )) {
            panic!("as a leak would");
        }
    }
}
