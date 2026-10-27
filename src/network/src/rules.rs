//! Exposure rules apply to the requested hostname and port before client-side resolution.
use std::net::IpAddr;

#[derive(Clone, Debug)]
pub struct Rules(Vec<Rule>);
#[derive(Clone, Debug)]
struct Rule {
    host: String,
    port: Option<u16>,
}

pub fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && (host.parse::<IpAddr>().is_ok()
            || host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-')))
}

impl Rules {
    pub fn parse(input: &str) -> Result<Self, String> {
        if input.is_empty() || input.len() > 4096 {
            return Err("Specify explicit exposure rules or <loopback>".into());
        }
        let mut rules = Vec::new();
        for raw in input.split(',') {
            let raw = raw.trim().to_ascii_lowercase();
            let (host, port) = if let Some(rest) = raw.strip_prefix('[') {
                let (host, rest) = rest.split_once(']').ok_or("Invalid IPv6 exposure rule")?;
                if !matches!(host.parse::<IpAddr>(), Ok(IpAddr::V6(_))) {
                    return Err("Invalid IPv6 exposure rule".into());
                }
                if !rest.is_empty() && !rest.starts_with(':') {
                    return Err("Invalid IPv6 exposure rule".into());
                }
                (host.to_owned(), rest.strip_prefix(':').map(str::to_owned))
            } else if raw.matches(':').count() <= 1 {
                match raw.split_once(':') {
                    Some((host, port)) => (host.to_owned(), Some(port.to_owned())),
                    None => (raw.clone(), None),
                }
            } else {
                return Err("Bracket IPv6 exposure rules".into());
            };
            if host != "<loopback>" && host != "*" && !valid_host(&host.replace('*', "x")) {
                return Err("Invalid exposure hostname".into());
            }
            let port = port
                .map(|port| port.parse::<u16>().map_err(|_| "Invalid exposure port"))
                .transpose()?;
            if port == Some(0) || rules.len() >= 64 {
                return Err("Exposure rules require valid ports and at most 64 entries".into());
            }
            let host = host
                .parse::<IpAddr>()
                .map(|ip| ip.to_string())
                .unwrap_or_else(|_| host.trim_end_matches('.').into());
            rules.push(Rule { host, port });
        }
        Ok(Self(rules))
    }

    pub fn matches(&self, host: &str, port: u16) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let host = host
            .parse::<IpAddr>()
            .map(|ip| ip.to_string())
            .unwrap_or(host);
        self.0.iter().any(|rule| {
            rule.port.is_none_or(|expected| expected == port)
                && if rule.host == "<loopback>" {
                    host == "localhost"
                        || host.ends_with(".localhost")
                        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
                } else {
                    glob(&rule.host, &host)
                }
        })
    }
}

fn glob(pattern: &str, value: &str) -> bool {
    let (mut p, mut v, mut star, mut retry) = (0, 0, None, 0);
    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    while v < value.len() {
        if p < pattern.len() && pattern[p] == value[v] {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(at) = star {
            retry += 1;
            v = retry;
            p = at + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destinations_are_explicit_and_port_scoped() {
        let rules = Rules::parse("localhost:3000,*.internal:8080,[::1]:9000").unwrap();
        assert!(rules.matches("LOCALHOST", 3000));
        assert!(!rules.matches("localhost", 8080));
        assert!(rules.matches("api.internal", 8080));
        assert!(!rules.matches("internal.evil", 8080));
        assert!(rules.matches("::1", 9000));
        assert!(!rules.matches("127.0.0.1", 9000));
        let local = Rules::parse("<loopback>").unwrap();
        assert!(local.matches("x.localhost", 42));
        assert!(local.matches("127.0.0.2", 42));
        assert!(!local.matches("localhost.evil", 42));
        for invalid in [
            "",
            "http://localhost:3000",
            "host:0",
            "host:99999",
            "[bad]:42",
            "localhost,,api",
        ] {
            assert!(Rules::parse(invalid).is_err(), "{invalid}");
        }
    }
}
