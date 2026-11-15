# dsh-antigravity

Plugin de [Cordis](https://cordis.io) para **DeepSeek Harness (DSH)** que expone la CLI de Google Antigravity (`agy`) como herramientas nativas del modelo.

Desde cualquier sesión de DSH el modelo puede delegar una tarea completa al agente de Antigravity y recibir su respuesta, listar modelos, comprobar el estado de la instalación y ejecutar Python.

- Cero dependencias en runtime (solo módulos `node:*`).
- ESM puro, sin build, sin TypeScript.

## Requisitos

- Node.js >= 20
- DeepSeek Harness con soporte de plugins Cordis (servicio `tools`)
- [Antigravity CLI](https://antigravity.google) (`agy`) instalada y autenticada (`agy` → login). Por defecto se busca en `~/.local/bin/agy`.
- `python3` en el `PATH` (solo para `run_python`)

## Instalación

Requiere una versión de DSH cuyo perfil use el loader de Cordis (servicio `tools`).

1. Añade el paquete al perfil con el passthrough de pnpm que expone `dsh plugin`:

   ```sh
   # desde git (repositorio público, no pide credenciales):
   dsh plugin --profile web add github:USUARIO/dsh-antigravity

   # desde una copia local del repo:
   dsh plugin --profile web add file:/ruta/a/dsh-antigravity

   # desde npm, si está publicado:
   dsh plugin --profile web add dsh-antigravity
   ```

2. Actívalo añadiendo el bloque `insert` a `~/.dsh/profiles/<perfil>/cordis.patch.yml`
   (copia [`examples/cordis.patch.yml`](examples/cordis.patch.yml)):

   ```yaml
   - insert:
       - id: antigravity
         name: dsh-antigravity
         config:
           agyPath: ~/.local/bin/agy
           skipPermissions: true
           timeoutSec: 300
   ```

   El patch se compone como una **lista** y solo puede modificar entradas
   existentes, por eso se usa `insert:` para añadir una nueva instancia. Si
   escribes `- id: antigravity` sin `insert:`, el loader avisa
   `entry "antigravity" not found` y lo ignora.

3. Reinicia el motor de DSH (la configuración del perfil se lee al arrancar) y
   pide al modelo que ejecute `agy_status`.

Verificación rápida sin reiniciar: `node test/smoke.mjs` (sin red ni `agy` real).

## Herramientas

| herramienta | argumentos | qué hace | resultado |
|---|---|---|---|
| `agy_run` | `prompt` (req.), `model`, `effort` (`low\|medium\|high\|xhigh\|max`), `mode` (`accept-edits\|auto\|plan`), `cwd`, `skipPermissions`, `timeoutSec` (1–3600) | Ejecuta `agy -p <prompt> --output-format json …` en modo headless | `{ ok, status, response, conversationId, model, durationSeconds, usage }` o `{ ok: false, error, stderrTail }` |
| `agy_models` | — | Ejecuta `agy models` y parsea `id\tNombre` | `{ ok, count, models: [{ id, name }], raw }` |
| `agy_status` | — | Comprueba binario, `agy --version` y credenciales OAuth (< 15 s) | `{ ok, installed, version, authenticated, agyPath, credentialsPath }` |
| `run_python` | `code` (req.), `cwd`, `timeoutSec` (1–600, def. 60) | Ejecuta `python3 -I` sobre un archivo temporal | `{ ok, exitCode, stdout, stderr }` (stdout ≤ 20000, stderr ≤ 4000 chars) |

Comportamiento común:

- Los fallos de `agy` o de Python **no lanzan**: se devuelven como `{ ok: false, error }`.
- Argumentos groseramente inválidos (p. ej. `prompt` o `code` vacío, enums desconocidos) lanzan `Error`.
- Si la sesión aborta (`exec.signal`), se mata el grupo de procesos hijo y se devuelve `{ ok: false, error: 'aborted' }`.
- Si vence el timeout: `{ ok: false, error: 'timeout after <n>s' }`.

## Configuración

Todos los campos son opcionales; valores inválidos o desconocidos se ignoran en silencio.

| campo | tipo | default | descripción |
|---|---|---|---|
| `agyPath` | string | `~/.local/bin/agy` | Ruta al binario (`~` se expande) |
| `cwd` | string | `process.cwd()` | Directorio de trabajo por defecto |
| `defaultModel` | string | `''` | Modelo por defecto (`''` = no pasar `--model`) |
| `defaultEffort` | string | `''` | Esfuerzo por defecto (`low\|medium\|high\|xhigh\|max`) |
| `skipPermissions` | boolean | `true` | Añade `--dangerously-skip-permissions` |
| `timeoutSec` | number | `300` | Timeout por defecto de `agy_run` (1–3600) |

## Seguridad

- Con `skipPermissions: true` (default) el agente de Antigravity puede **editar archivos y ejecutar comandos sin confirmación** dentro de `cwd`. Ponlo a `false` o usa `mode: plan` si quieres un agente de solo lectura/planificación.
- `run_python` ejecuta código arbitrario con los permisos del usuario que corre DSH. `-I` (modo aislado) solo ignora variables `PYTHON*` y el site del usuario; **no es un sandbox**.
- Los procesos se lanzan sin shell (`spawn` con `argv`), así que el `prompt` y el código no sufren inyección de shell.
- El plugin no lee ni transmite las credenciales: solo comprueba si existe `~/.gemini/antigravity-cli/antigravity-oauth-token`.

## Solución de problemas

| síntoma | causa probable / solución |
|---|---|
| `agy not found or not executable` | Instala `agy` o ajusta `agyPath`; comprueba `chmod +x`. |
| `agy_status` → `authenticated: false` | Ejecuta `agy` una vez en una terminal e inicia sesión. |
| `timeout after <n>s` | Sube `timeoutSec` (argumento o config) o divide la tarea. |
| `could not parse agy JSON output` | Versión de `agy` sin `--output-format json`; actualízala. Revisa `stderrTail`. |
| `cwd is not a directory` | Pasa un `cwd` existente (relativo a la config `cwd` o absoluto). |
| `command not found: python3` | Instala Python 3 o añádelo al `PATH` del proceso de DSH. |

## Desarrollo

```sh
node test/smoke.mjs   # sin red, sin agy real, sin npm install
```

## Licencia

MIT © 2026 Jhon Alberto Perez
