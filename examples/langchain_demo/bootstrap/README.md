# Bootstrap

`bootstrap/main.py` remains the broker-mode setup path for a fuller external Caracal runtime.

Use it when you want to provision workspace resources outside the lightweight local app:
- principals
- providers
- tool registry entries
- mandates
- attestation bootstrap artifacts

## Commands

Dry-run:

```bash
python -m examples.langchain_demo.bootstrap.main
```

Apply:

```bash
python -m examples.langchain_demo.bootstrap.main --apply
```

Apply and restart runtime for attestation:

```bash
python -m examples.langchain_demo.bootstrap.main --apply --restart-runtime-for-attestation
```

Artifacts live under:
- `examples/langchain_demo/bootstrap/artifacts`
