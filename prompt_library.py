import json
import os
import uuid
import re
import random
import stat
import tempfile
from datetime import datetime
from aiohttp import web
import folder_paths
from server import PromptServer

LIBRARY_FILENAME = "prompt_library_data.json"
LEGACY_LIBRARY_FILE = os.path.join(os.path.dirname(__file__), LIBRARY_FILENAME)
LIBRARY_FILE = os.path.join(folder_paths.get_user_directory(), LIBRARY_FILENAME)


class LibraryValidationError(ValueError):
    """Raised when replacement library data does not match the expected schema."""


def validate_library(data):
    """Validate and normalize a complete prompt library."""
    if not isinstance(data, dict):
        raise LibraryValidationError("The library root must be a JSON object.")

    categories = data.get("categories")
    prompts = data.get("prompts")
    if not isinstance(categories, list) or not isinstance(prompts, list):
        raise LibraryValidationError("The library must contain categories and prompts arrays.")

    category_ids = set()
    parent_by_id = {}
    for index, category in enumerate(categories):
        label = f"Category at index {index}"
        if not isinstance(category, dict):
            raise LibraryValidationError(f"{label} must be an object.")

        category_id = category.get("id")
        if (
            not isinstance(category_id, str)
            or not category_id.strip()
            or category_id != category_id.strip()
            or "," in category_id
        ):
            raise LibraryValidationError(
                f"{label} must have a non-empty string id without commas or outer whitespace."
            )
        if category_id in category_ids:
            raise LibraryValidationError(f"Duplicate category id: {category_id}")
        category_ids.add(category_id)

        name = category.get("name")
        if not isinstance(name, str) or not name.strip():
            raise LibraryValidationError(f"{label} must have a non-empty string name.")

        parent_id = category.get("parent_id")
        if parent_id is not None and (not isinstance(parent_id, str) or not parent_id.strip()):
            raise LibraryValidationError(f"{label} has an invalid parent_id.")
        parent_by_id[category_id] = parent_id

        color = category.get("color", "#6366f1")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise LibraryValidationError(f"{label} has an invalid color; use a six-digit hex color.")
        category.setdefault("parent_id", None)
        category.setdefault("color", "#6366f1")

        created_at = category.get("created_at")
        if created_at is not None and not isinstance(created_at, str):
            raise LibraryValidationError(f"{label} has an invalid created_at value.")

    for category_id, parent_id in parent_by_id.items():
        if parent_id is not None and parent_id not in category_ids:
            raise LibraryValidationError(
                f"Category {category_id} references an unknown parent category."
            )
        if parent_id == category_id:
            raise LibraryValidationError(f"Category {category_id} cannot be its own parent.")

        visited = {category_id}
        current_id = parent_id
        while current_id is not None:
            if current_id in visited:
                raise LibraryValidationError("Category parent references contain a cycle.")
            visited.add(current_id)
            current_id = parent_by_id.get(current_id)

    prompt_ids = set()
    for index, prompt in enumerate(prompts):
        label = f"Prompt at index {index}"
        if not isinstance(prompt, dict):
            raise LibraryValidationError(f"{label} must be an object.")

        prompt_id = prompt.get("id")
        if (
            not isinstance(prompt_id, str)
            or not prompt_id.strip()
            or prompt_id != prompt_id.strip()
            or "," in prompt_id
        ):
            raise LibraryValidationError(
                f"{label} must have a non-empty string id without commas or outer whitespace."
            )
        if prompt_id in prompt_ids:
            raise LibraryValidationError(f"Duplicate prompt id: {prompt_id}")
        prompt_ids.add(prompt_id)

        title = prompt.get("title")
        text = prompt.get("text")
        if not isinstance(title, str) or not title.strip():
            raise LibraryValidationError(f"{label} must have a non-empty string title.")
        if not isinstance(text, str) or not text.strip():
            raise LibraryValidationError(f"{label} must have non-empty string text.")

        category_id = prompt.get("category_id")
        if category_id is not None and (
            not isinstance(category_id, str) or not category_id.strip()
        ):
            raise LibraryValidationError(f"{label} has an invalid category_id.")
        if category_id is not None and category_id not in category_ids:
            raise LibraryValidationError(f"{label} references an unknown category.")

        negative = prompt.get("negative", "")
        if not isinstance(negative, str):
            raise LibraryValidationError(f"{label} has an invalid negative prompt.")

        tags = prompt.get("tags", [])
        if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise LibraryValidationError(f"{label} tags must be an array of strings.")
        prompt.setdefault("category_id", None)
        prompt.setdefault("negative", "")
        prompt.setdefault("tags", [])

        for field in ("created_at", "updated_at"):
            value = prompt.get(field)
            if value is not None and not isinstance(value, str):
                raise LibraryValidationError(f"{label} has an invalid {field} value.")

    return data


def migrate_legacy_library():
    """Copy legacy node-local data to the ComfyUI user directory once."""
    if os.path.exists(LIBRARY_FILE) or not os.path.exists(LEGACY_LIBRARY_FILE):
        return

    try:
        with open(LEGACY_LIBRARY_FILE, "r", encoding="utf-8") as legacy_file:
            legacy_data = validate_library(json.load(legacy_file))
        save_library(legacy_data)
    except (OSError, UnicodeError, json.JSONDecodeError, LibraryValidationError):
        pass


def load_library():
    """Load the prompt library from the configured ComfyUI user directory."""
    migrate_legacy_library()
    if os.path.exists(LIBRARY_FILE):
        try:
            with open(LIBRARY_FILE, "r", encoding="utf-8") as library_file:
                return json.load(library_file)
        except (OSError, UnicodeError, json.JSONDecodeError):
            pass
    return {"categories": [], "prompts": []}


def save_library(data):
    """Atomically save the prompt library in the ComfyUI user directory."""
    directory = os.path.dirname(LIBRARY_FILE)
    os.makedirs(directory, exist_ok=True)
    existing_mode = (
        stat.S_IMODE(os.stat(LIBRARY_FILE).st_mode) if os.path.exists(LIBRARY_FILE) else None
    )
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=directory,
            prefix="prompt_library_",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = temporary_file.name
            json.dump(data, temporary_file, indent=2, ensure_ascii=False)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        if existing_mode is not None:
            os.chmod(temporary_path, existing_mode)
        os.replace(temporary_path, LIBRARY_FILE)
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.remove(temporary_path)


def process_random_segments(text, rng=None):
    """
    Finds segments like {abc|xyz|123} and picks one choice randomly.
    Supports nested segments like {a|{b|c}}.
    Can use a provided random.Random instance for deterministic results.
    """
    if not text:
        return text

    if rng is None:
        rng = random

    def replace_choice(match):
        choices = match.group(1).split("|")
        return rng.choice(choices)

    # Regex: find anything inside { } that contains at least one |
    # and does NOT contain nested brackets. This ensures we process from inside out.
    pattern = r"\{([^{}]*\|[^{}]*)\}"
    
    # Process from the inside out until no more patterns match
    new_text = text
    while True:
        processed = re.sub(pattern, replace_choice, new_text)
        if processed == new_text:
            break
        new_text = processed
        
    return new_text


# ──────────────────────────────────────────────
#  REST API routes
# ──────────────────────────────────────────────
routes = PromptServer.instance.routes


@routes.get("/prompt_library/data")
async def get_library(request):
    return web.json_response(load_library())


@routes.post("/prompt_library/data")
async def save_library_route(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response(
            {"status": "error", "error": "The request does not contain valid JSON."}, status=400
        )

    try:
        validated_data = validate_library(data)
    except LibraryValidationError as error:
        return web.json_response({"status": "error", "error": str(error)}, status=400)

    save_library(validated_data)
    return web.json_response({"status": "ok", "data": validated_data})


@routes.post("/prompt_library/category")
async def add_category(request):
    body = await request.json()
    library = load_library()
    category = {
        "id": str(uuid.uuid4()),
        "name": body["name"],
        "parent_id": body.get("parent_id"),
        "color": body.get("color", "#6366f1"),
        "created_at": datetime.now().isoformat(),
    }
    library["categories"].append(category)
    save_library(library)
    return web.json_response(category)


@routes.put("/prompt_library/category/{cat_id}")
async def update_category(request):
    cat_id = request.match_info["cat_id"]
    body = await request.json()
    library = load_library()
    for cat in library["categories"]:
        if cat["id"] == cat_id:
            cat.update({k: v for k, v in body.items() if k != "id"})
            break
    save_library(library)
    return web.json_response({"status": "ok"})


@routes.delete("/prompt_library/category/{cat_id}")
async def delete_category(request):
    cat_id = request.match_info["cat_id"]
    library = load_library()
    # Remove category and all sub-categories
    def get_all_ids(pid):
        ids = {pid}
        for c in library["categories"]:
            if c.get("parent_id") == pid:
                ids |= get_all_ids(c["id"])
        return ids

    ids_to_delete = get_all_ids(cat_id)
    library["categories"] = [c for c in library["categories"] if c["id"] not in ids_to_delete]
    library["prompts"] = [p for p in library["prompts"] if p.get("category_id") not in ids_to_delete]
    save_library(library)
    return web.json_response({"status": "ok"})


@routes.post("/prompt_library/prompt")
async def add_prompt(request):
    body = await request.json()
    library = load_library()
    prompt = {
        "id": str(uuid.uuid4()),
        "title": body["title"],
        "text": body["text"],
        "negative": body.get("negative", ""),
        "category_id": body.get("category_id"),
        "tags": body.get("tags", []),
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    library["prompts"].append(prompt)
    save_library(library)
    return web.json_response(prompt)


@routes.put("/prompt_library/prompt/{prompt_id}")
async def update_prompt(request):
    prompt_id = request.match_info["prompt_id"]
    body = await request.json()
    library = load_library()
    for p in library["prompts"]:
        if p["id"] == prompt_id:
            p.update({k: v for k, v in body.items() if k != "id"})
            p["updated_at"] = datetime.now().isoformat()
            break
    save_library(library)
    return web.json_response({"status": "ok"})


@routes.delete("/prompt_library/prompt/{prompt_id}")
async def delete_prompt(request):
    prompt_id = request.match_info["prompt_id"]
    library = load_library()
    library["prompts"] = [p for p in library["prompts"] if p["id"] != prompt_id]
    save_library(library)
    return web.json_response({"status": "ok"})


# ──────────────────────────────────────────────
#  ComfyUI Node definition
# ──────────────────────────────────────────────
class PromptLibraryNode:
    """
    A node that lets you browse your saved prompt library
    and pipe a selected prompt into your workflow.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
				"prompts": ("STRING", {"default": ""}),
                "prompt_ids": ("STRING", {"default": ""}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**31 - 1}),
            },
            "optional": {
                "prefix": ("STRING", {"default": "", "multiline": False}),
                "suffix": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "load_prompt"
    CATEGORY = "utils/prompts"
    OUTPUT_NODE = False

    def load_prompt(self, prompts="", prompt_ids="", seed=-1, prefix="", suffix=""):
        library = load_library()
        ids = [pid.strip() for pid in prompt_ids.split(",") if pid.strip()]
        matched = [p for p in library["prompts"] if p["id"] in ids]
        # Preserve the order from prompt_ids
        id_order = {pid: i for i, pid in enumerate(ids)}
        matched.sort(key=lambda p: id_order.get(p["id"], 0))

        texts = [p["text"].strip() for p in matched if p["text"].strip()]
        negatives = [p["negative"].strip() for p in matched if p.get("negative", "").strip()]

        positive = ", ".join(filter(None, [prefix.strip()] + texts + [suffix.strip()]))
        negative = ", ".join(negatives)

        # Apply randomization
        rng = random.Random(seed if seed != -1 else None)
        positive = process_random_segments(positive, rng)
        negative = process_random_segments(negative, rng)

        return (positive, negative)


class PromptLibraryRandomNode:
    """
    Picks a random prompt from one or more selected categories
    every time the workflow runs.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Comma-separated category IDs chosen in the UI
                "category_ids": ("STRING", {"default": ""}),
                # -1 = truly random each run, any other value = fixed seed
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**31 - 1}),
            },
            "optional": {
                "prefix": ("STRING", {"default": "", "multiline": False}),
                "suffix": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive", "negative", "prompt_title", "prompt_id")
    FUNCTION = "pick_random"
    CATEGORY = "utils/prompts"
    OUTPUT_NODE = False

    def pick_random(self, category_ids, seed=-1, prefix="", suffix=""):
        library = load_library()

        if not category_ids.strip():
            return ("", "", "", "")

        selected_ids = [cid.strip() for cid in category_ids.split(",") if cid.strip()]

        # Collect all descendant category ids
        def get_descendants(cid):
            ids = {cid}
            for c in library["categories"]:
                if c.get("parent_id") == cid:
                    ids |= get_descendants(c["id"])
            return ids

        all_cat_ids = set()
        for cid in selected_ids:
            all_cat_ids |= get_descendants(cid)

        pool = [p for p in library["prompts"] if p.get("category_id") in all_cat_ids]

        if not pool:
            return ("", "", "", "")

        rng = random.Random(seed if seed != -1 else None)
        chosen = rng.choice(pool)

        positive = " ".join(filter(None, [prefix.strip(), chosen["text"].strip(), suffix.strip()]))
        negative = chosen.get("negative", "")

        # Apply randomization using the same seed for reproducibility if seed != -1
        positive = process_random_segments(positive, rng)
        negative = process_random_segments(negative, rng)

        return (positive, negative, chosen.get("title", ""), chosen["id"])


class StringConcatenateNode:
    """
    A simple node that concatenates n string inputs.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "delimiter": ("STRING", {"default": ", "}),
                "input_count": ("INT", {"default": 2, "min": 2, "max": 20, "step": 1}),
            },
            "optional": {
                **{
                    f"string{i}": ("STRING", {"forceInput": True, "default": ""})
                    for i in range(1, 21)
                }
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Result",)
    FUNCTION = "concatenate"
    CATEGORY = "utils/strings"

    def concatenate(self, delimiter, input_count, **kwargs):
        values = []
        for i in range(1, input_count + 1):
            k = f"string{i}"
            if k in kwargs:
                values.append(str(kwargs[k]))
        return (delimiter.join(values),)

NODE_CLASS_MAPPINGS = {
    "PromptLibraryNode": PromptLibraryNode,
    "PromptLibraryRandomNode": PromptLibraryRandomNode,
    "StringConcatenateNode": StringConcatenateNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptLibraryNode": "📚 Prompt Library",
    "PromptLibraryRandomNode": "🎲 Prompt Library — Random",
    "StringConcatenateNode": "🔡 String Concatenate",
}
