# Python Role Lens

A productivity extension for Python developers using the **Role Delegation pattern** (e.g., `Role[T]`). 

Navigate through your complex object hierarchies with ease. Stop fighting `__getattr__` and start coding.

## Features

* **Recursive Autocomplete:** Automatically discovers attributes across nested `Role` proxies.
* **Intelligent Navigation:** `Ctrl + Click` (or `Cmd + Click`) on delegated attributes (`name`, `age`, `company`) warps your cursor directly to the source declaration, bypassing the dynamic `__getattr__` call.
* **Pylance Synergy:** Intelligently detects native class attributes to avoid duplicate definition popups, providing a seamless "native-feel" experience.

## Getting Started

1. Install the extension from the VS Code Marketplace.
2. Ensure your Python classes follow the standard `Role` pattern:
   ```python
   @dataclass
   class Role(Generic[RoleTakerT]):
       _taker: RoleTakerT
       ...
    ```
## How it works

This extension performs static analysis of your class hierarchy to map Role relations. When you navigate to a definition, the extension intercepts the request. If the field is defined natively on the class, it defers to Pylance. If the field is delegated, it recursively resolves the composition chain and teleports you to the absolute origin of the attribute.

## Requirements

- VS Code 1.60.0 or higher.
- Pylance language server enabled.

## License

MIT