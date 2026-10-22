# GitHub source delivery

Target repository: `lannylerner7-cyber/secure-remote-view`.
Review branch: `replit/connectlive-source-update`.

The export starts from the existing GitHub main history and retains the app at
repository root, which is the layout expected by its Dockerfile and Coolify.
The workspace's `imports/connectlive/` prefix is removed only during export.
Verification helpers and tests are adapted to the root layout. Application and
native source files are copied byte-for-byte.

Included: current web/backend, Windows Agent/Admin, migrations, email work,
configuration examples, regression helpers and verification documentation.
Excluded: workspace tooling/profile files, uploaded archives, compiled outputs,
private credentials and generated Windows ZIPs. The formerly tracked `.env` is
removed from this branch; set build/runtime configuration explicitly in Coolify.
This does not erase that file from old Git history.

Checks completed on the export:
- Node-server web build using the existing workspace dependency installation.
- Email flow, SMTP transport and newsletter configuration regression checks.
- Fresh-profile Agent configuration regression and native gateway checks.
- Native sources match every file hash recorded in the delivered Windows ZIPs.
- Staged path/credential-pattern checks and git whitespace checks.

This is not a clean Docker build, a production deployment, a comprehensive
security scan or a Windows runtime test. Existing client defects remain listed
in `docs/review/README.md`. Review the branch before merging to a Coolify-connected
branch. Automatic synchronization is not configured.

The post-push manifest records the exact remotely confirmed commit and archive
hashes. The previously delivered ZIPs remain unchanged.
