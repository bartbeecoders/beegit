//! `beegit` binary: forwards to [`beegit_cli::run`].

use beegit_cli::CliIo;
use std::io::{BufRead, Write};

struct StdIo {
    out: std::io::Stdout,
    err: std::io::Stderr,
}

impl CliIo for StdIo {
    fn stdout(&mut self) -> &mut dyn Write {
        &mut self.out
    }

    fn stderr(&mut self) -> &mut dyn Write {
        &mut self.err
    }

    fn stdin_line(&mut self) -> Option<String> {
        let mut line = String::new();
        match std::io::stdin().lock().read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_owned()),
        }
    }
}

fn main() {
    let mut io = StdIo {
        out: std::io::stdout(),
        err: std::io::stderr(),
    };
    let code = beegit_cli::run(
        std::env::args_os().collect(),
        &beegit_config::ProcessEnv,
        &mut io,
    );
    std::process::exit(code);
}
