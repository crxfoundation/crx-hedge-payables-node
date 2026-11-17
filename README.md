# CRX payables hedge: Node

A US importer owes a BRL invoice in 30 days and an MXN invoice in 60 days.
This script requests CRX quotes for non-deliverable forwards (NDFs) that sell USD forward against each currency, and books them on request.
It calls the public CRX REST API with `fetch`. Margin and settlement are in USDC.

## Install

Node 22.18 or newer runs `hedge.ts` directly.

```bash
npm install
```

## Run read-only

No key needed. The script reads `GET /health` and `GET /markets`, then prints each quote request without sending it.

```bash
node hedge.ts
```

Sample output: [RUN.txt](RUN.txt).

## Run with keys

Set `CRX_WALLET_PK` to the private key of an onboarded CRX account wallet, or `CRX_WALLET_PK_FILE` to a file that holds it. The account needs free USDC collateral for the margin.

```bash
export CRX_WALLET_PK_FILE=wallet.key
node hedge.ts --quote    # request a quote for each invoice; books nothing
node hedge.ts --accept   # request a quote for each invoice and book it
```

Each call with a key carries the signed headers the API reference describes (EIP-191). An accept signs the `Trade` (EIP-712) only when the served terms match the request.

`--accept` books live trades. To change the invoices, edit `PAYABLES` in `hedge.ts`. The notional is in USD, at least 100 USD. Pairs: USD/BRL and USD/MXN.

## Links

- [NDFs on CRX](https://crxfx.com/ndf)
- [Pricing](https://crxfx.com/pricing)
- [API reference (OpenAPI)](https://discover.crxfx.com/openapi-taker.yaml)

## License

Use only to access CRX services. See [LICENSE](LICENSE).
