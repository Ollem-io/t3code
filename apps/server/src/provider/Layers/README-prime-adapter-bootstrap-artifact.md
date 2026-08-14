# PA-M07 Prime adapter bootstrap artifact

Generate from the reviewed TypeScript source and run without repository dependencies:

```sh
./generate-prime-adapter-bootstrap-artifact.sh
cp prime-adapter-bootstrap-artifact.mjs /tmp/
cd /tmp && node prime-adapter-bootstrap-artifact.mjs
```

The artifact launches only its temporary fake binary and asserts the dedicated RPC argv, exact cwd and session path, isolated HOME, `get_state` handshake, absence of ACP, duplicate owned flags, and secret-bearing argv. It deletes all temporary resources.
