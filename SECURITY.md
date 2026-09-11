# Security Policy

## Reporting a Vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://github.com/mewset/better-iptv/security/advisories/new).
It is enabled on this repository, the report is visible only to the maintainer,
and it gives us a private place to discuss a fix and to credit you when it ships.

Please do not open a public issue for a security problem. A public report tells
everyone how to exploit it before there is a version to upgrade to.

Better IPTV is maintained by one person in his spare time. You should get a first
reply within a week. If a week passes with no answer, open a normal issue saying
only that you are waiting on a security report, with no details, and I will pick
it up from there.

### What helps

- The version you tested, and your operating system
- What an attacker gains, not only what misbehaves
- Steps to reproduce, ideally a minimal playlist or file that triggers it
- Any proof-of-concept you already have

You do not need a full write-up to report something. A clear description of the
problem is enough to start.

### Disclosure

Report it privately, give us time to ship a fix, and publish whatever you like
afterwards. If you want a deadline, say so in the report and we will work to it.
Anything else is up to you: you are not required to stay quiet indefinitely, and
you are welcome to be named in the advisory and in the changelog, or not, as you
prefer.

## Supported Versions

Only the latest release gets security fixes. Older versions are not patched, so
the fix for anything reported here will ship in the next release.

## Scope

The app is a desktop player. Its threat model is a playlist or program guide you
did not write: an M3U file, an Xtream provider or an XMLTV source can all be
hostile, and nothing in them may reach your machine as anything but data.

In scope:

- Anything in a playlist, a program guide or a provider response that leads to
  code execution, file access or arbitrary process arguments
- Command or argument injection into MPV
- Escaping the webview's content security policy, or reaching a Tauri command
  that should not be reachable
- Exposure of stored credentials, including the parental control PIN
- A network listener or service the app opens without you asking

Out of scope:

- Vulnerabilities in MPV itself, report those to
  [the MPV project](https://github.com/mpv-player/mpv/security)
- Vulnerabilities in a stream provider's servers rather than in this app
- An attacker who already has local access to your user account or your database
- Missing hardening that has no path to an actual impact, unless you can show
  one
- The fact that the app plays streams from addresses you give it. Fetching a URL
  the user typed is the purpose of the program
