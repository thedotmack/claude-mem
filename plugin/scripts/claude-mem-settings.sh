#!/bin/bash
# claude-mem-settings.sh - User settings manager for claude-mem plugin

USER_SETTINGS_FILE="$HOME/.claude/settings.json"

# Function to check if jq is available
check_jq() {
    if ! command -v jq &> /dev/null; then
        echo "Error: jq is required for JSON manipulation"
        echo "Install with: brew install jq"
        exit 1
    fi
}

# Function to create settings file if it doesn't exist
ensure_settings_file() {
    if [ ! -f "$USER_SETTINGS_FILE" ]; then
        mkdir -p "$(dirname "$USER_SETTINGS_FILE")"
        echo '{}' > "$USER_SETTINGS_FILE"
    fi
}

# Function to get current model setting
get_model() {
    if [ -f "$USER_SETTINGS_FILE" ]; then
        jq -r '.env.CLAUDE_MEM_MODEL // "claude-sonnet-4-5"' "$USER_SETTINGS_FILE"
    else
        echo "claude-sonnet-4-5"
    fi
}

# Function to set model setting
set_model() {
    local model=$1

    ensure_settings_file

    # Update or create the env.CLAUDE_MEM_MODEL setting
    jq --arg model "$model" '.env.CLAUDE_MEM_MODEL = $model' "$USER_SETTINGS_FILE" > tmp.json && mv tmp.json "$USER_SETTINGS_FILE"
    echo "Set CLAUDE_MEM_MODEL to: $model"
}

# Function to remove model setting
remove_model() {
    if [ -f "$USER_SETTINGS_FILE" ]; then
        jq 'del(.env.CLAUDE_MEM_MODEL)' "$USER_SETTINGS_FILE" > tmp.json && mv tmp.json "$USER_SETTINGS_FILE"
        echo "Removed CLAUDE_MEM_MODEL (will use default: claude-sonnet-4-5)"
    fi
}

# Function to list available models
list_models() {
    echo "Available models:"
    echo "  claude-haiku-4-5     - Fast and efficient"
    echo "  claude-sonnet-4-5    - Balanced (default)"
    echo "  claude-opus-4        - Most capable"
    echo "  claude-3-7-sonnet    - Alternative version"
}

# Interactive menu
show_menu() {
    echo "Claude Mem Plugin - Model Configuration"
    echo "======================================"
    echo "Current model: $(get_model)"
    echo "Settings file: $USER_SETTINGS_FILE"
    echo ""
    echo "1) Set model"
    echo "2) Remove model setting (use default)"
    echo "3) List available models"
    echo "4) Exit"
    echo ""
}

# Main interactive loop
main() {
    check_jq

    while true; do
        show_menu
        read -p "Choose an option (1-4): " choice

        case $choice in
            1)
                list_models
                echo ""
                read -p "Enter model name: " model
                set_model "$model"
                ;;
            2)
                remove_model
                ;;
            3)
                list_models
                ;;
            4)
                echo "Goodbye!"
                exit 0
                ;;
            *)
                echo "Invalid option. Please choose 1-4."
                ;;
        esac
        echo ""
        read -p "Press Enter to continue..."
    done
}

# Run main if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
