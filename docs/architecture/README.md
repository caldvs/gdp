# Architecture

Diagrams of the system as it is on `main`.

| Diagram | Shows |
| --- | --- |
| [System](system.html) | Clients, the web app, API Gateway, the Lambda with every endpoint, AWS services and third parties |
| [Data model](data-model.html) | The DynamoDB single table: every item type, its keys and TTL, the GSI, access patterns and transactions |
| [Domains and certificates](domains.md) | How `paymeback.dev` names reach Vercel and AWS, how the API certificate is issued, why `API_DOMAIN`/`API_CERT_ARN` are GitHub variables, where config lives |

The `.html` files are the real diagrams (light and dark theme, readable at any size). GitHub won't render them, so open them locally or use the PNG previews below.

## Design boards

Kept as boards on claude.ai (private to Callum):

| Board | Shows |
| --- | --- |
| [Option D service map](https://claude.ai/code/artifact/df51259b-42ab-414e-8fbb-988b92effc1c) | The whole meal as a service blueprint, the lead's and guest's journeys, and the moments that branch |
| [Domains & certificates map](https://claude.ai/artifact/4wqQZFykwj8it1GN2wAXwD) | The same content as [domains.md](domains.md), as boards |

## System

![System architecture](system.png)

## Data model

![DynamoDB data model](data-model.png)

## Updating

The pages are generated. Edit the script, not the HTML:

- `src/system.py` + `src/system.template.html` → `system.html`
- `src/data_model.py` + `src/data_model.template.html` → `data-model.html`

```sh
python3 docs/architecture/src/system.py
python3 docs/architecture/src/data_model.py
```

Then refresh the PNGs with any headless Chrome:

```sh
cd docs/architecture
google-chrome --headless=new --hide-scrollbars --window-size=1720,1700 --screenshot=system.png "file://$PWD/system.html"
google-chrome --headless=new --hide-scrollbars --window-size=1600,3500 --screenshot=data-model.png "file://$PWD/data-model.html"
```

Sources of truth: `apps/api/openapi.yaml` for endpoints, `apps/api/infra/main.ts` for AWS resources, `apps/api/src/storage/*` for keys. Update the diagrams in the same PR as a change to any of those.
