#!/bin/bash
# LivePipe Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/xiikii/livepipe/main/install.sh | bash

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Installation directory
INSTALL_DIR="$HOME/.livepipe"
BIN_LINK="/usr/local/bin/live"

echo -e "${CYAN}🚀 Installing LivePipe...${NC}\n"

# Check if already installed
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠  LivePipe is already installed at $INSTALL_DIR${NC}"
    read -p "Overwrite existing installation? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
    echo -e "${YELLOW}→${NC} Removing old installation..."
    rm -rf "$INSTALL_DIR"
fi

# Download project
echo -e "${CYAN}📦 Downloading LivePipe...${NC}"

# Check if LIVEPIPE_LOCAL_PATH is set (for local testing)
if [ -n "$LIVEPIPE_LOCAL_PATH" ]; then
    echo -e "${YELLOW}→${NC} Using local path: $LIVEPIPE_LOCAL_PATH"
    cp -r "$LIVEPIPE_LOCAL_PATH" "$INSTALL_DIR"
    echo -e "${GREEN}✓${NC} Project copied from local path\n"
elif command -v git &> /dev/null; then
    git clone https://github.com/xiikii/livepipe.git "$INSTALL_DIR"
    echo -e "${GREEN}✓${NC} Project downloaded\n"
else
    echo -e "${YELLOW}⚠  Git not found, downloading tarball...${NC}"
    mkdir -p "$INSTALL_DIR"
    curl -fsSL https://github.com/xiikii/livepipe/archive/refs/heads/main.tar.gz | tar -xz --strip-components=1 -C "$INSTALL_DIR"
    echo -e "${GREEN}✓${NC} Project downloaded\n"
fi

# Check and install Bun
echo -e "${CYAN}🔍 Checking dependencies...${NC}\n"

if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}⚠  Bun not found${NC}"
    echo -e "${CYAN}→${NC} Installing Bun..."
    curl -fsSL https://bun.sh/install | bash

    # Add Bun to PATH for current session
    export PATH="$HOME/.bun/bin:$PATH"

    if command -v bun &> /dev/null; then
        echo -e "${GREEN}✓${NC} Bun installed"
    else
        echo -e "${RED}✗${NC} Bun installation failed"
        echo "Please install Bun manually: https://bun.sh"
        exit 1
    fi
else
    BUN_VERSION=$(bun --version)
    echo -e "${GREEN}✓${NC} Bun $BUN_VERSION found"
fi

# Check Ollama
if command -v ollama &> /dev/null; then
    OLLAMA_VERSION=$(ollama --version | head -n 1)
    echo -e "${GREEN}✓${NC} Ollama $OLLAMA_VERSION found"
else
    echo -e "${YELLOW}⚠  Ollama not found${NC}"
    echo -e "${CYAN}→${NC} Install command: curl -fsSL https://ollama.com/install.sh | sh"
    read -p "Install Ollama now? [Y/n] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        curl -fsSL https://ollama.com/install.sh | sh
        if command -v ollama &> /dev/null; then
            echo -e "${GREEN}✓${NC} Ollama installed"
        else
            echo -e "${RED}✗${NC} Ollama installation failed"
            echo "You can install it later manually."
        fi
    else
        echo -e "${YELLOW}→${NC} Skipping Ollama installation (you can install it later)"
    fi
fi

# Check Screenpipe
if command -v screenpipe &> /dev/null; then
    SCREENPIPE_VERSION=$(screenpipe --version | head -n 1)
    echo -e "${GREEN}✓${NC} Screenpipe $SCREENPIPE_VERSION found"
else
    echo -e "${YELLOW}⚠  Screenpipe not found${NC}"
    echo -e "${CYAN}→${NC} Install command: curl -fsSL get.screenpi.pe/cli | sh"
    read -p "Install Screenpipe now? [Y/n] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        curl -fsSL get.screenpi.pe/cli | sh
        if command -v screenpipe &> /dev/null; then
            echo -e "${GREEN}✓${NC} Screenpipe installed"
        else
            echo -e "${RED}✗${NC} Screenpipe installation failed"
            echo "You can install it later manually."
        fi
    else
        echo -e "${YELLOW}→${NC} Skipping Screenpipe installation (you can install it later)"
    fi
fi

# Check PM2
if command -v pm2 &> /dev/null; then
    PM2_VERSION=$(pm2 --version)
    echo -e "${GREEN}✓${NC} PM2 $PM2_VERSION found"
else
    echo -e "${YELLOW}⚠  PM2 not found${NC}"
    echo -e "${CYAN}→${NC} Installing PM2..."
    bun install -g pm2
    if command -v pm2 &> /dev/null; then
        echo -e "${GREEN}✓${NC} PM2 installed"
    else
        echo -e "${RED}✗${NC} PM2 installation failed"
        exit 1
    fi
fi

# Install project dependencies
echo ""
echo -e "${CYAN}📦 Installing project dependencies...${NC}"
cd "$INSTALL_DIR"
bun install --frozen-lockfile

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Dependencies installed"
else
    echo -e "${RED}✗${NC} Dependency installation failed"
    exit 1
fi

# Pull Ollama model
if command -v ollama &> /dev/null; then
    echo ""
    if ollama list | grep -q "qwen3:1.7b"; then
        echo -e "${GREEN}✓${NC} Model qwen3:1.7b already available"
    else
        echo -e "${YELLOW}⚠  Model qwen3:1.7b not found${NC}"
        read -p "Pull model now? (this may take a while) [Y/n] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
            echo -e "${CYAN}→${NC} Pulling model (500MB)..."
            ollama pull qwen3:1.7b
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓${NC} Model downloaded"
            else
                echo -e "${RED}✗${NC} Model download failed"
                echo "You can pull it later with: ollama pull qwen3:1.7b"
            fi
        else
            echo -e "${YELLOW}→${NC} Skipping model download (pull later: ollama pull qwen3:1.7b)"
        fi
    fi
fi

# Setup PM2 log rotation
echo ""
echo -e "${CYAN}⚙️  Configuring PM2...${NC}"

# Try to install pm2-logrotate, but don't fail if it errors
# (There's a known issue with Bun and PM2 module installation)
if command -v npm &> /dev/null; then
    # Use npm if available (more reliable for PM2 modules)
    if ! pm2 ls 2>/dev/null | grep -q "pm2-logrotate"; then
        echo -e "${YELLOW}→${NC} Installing PM2 log rotation module..."
        NPM_CONFIG_PREFIX=$HOME/.pm2/modules npm install -g pm2-logrotate 2>/dev/null || true
        pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
    fi
else
    # Skip if npm not available (Bun has compatibility issues with PM2 modules)
    echo -e "${YELLOW}⚠${NC} Skipping PM2 log rotation (npm not found, non-critical)"
    echo -e "${YELLOW}→${NC} You can install it later with: npm install -g pm2-logrotate"
fi
echo -e "${GREEN}✓${NC} PM2 configured"

# Create config file
echo ""
echo -e "${CYAN}📝 Creating configuration...${NC}"
if [ ! -f "$INSTALL_DIR/config.json" ]; then
    cp "$INSTALL_DIR/config.template.json" "$INSTALL_DIR/config.json"
    echo -e "${GREEN}✓${NC} Configuration created"
else
    echo -e "${GREEN}✓${NC} Configuration already exists"
fi

# Create symlink
echo ""
echo -e "${CYAN}🔗 Creating command symlink...${NC}"
echo ""
echo -e "${YELLOW}ℹ️  Creating global 'live' command requires sudo access${NC}"
echo -e "   This will create a symlink: /usr/local/bin/live → ~/.livepipe/bin/live"
echo -e "   So you can run 'live' commands from anywhere in your terminal."
echo ""
echo -e "   Examples:"
echo -e "     ${CYAN}live start${NC}    - Start all services (Screenpipe + Ollama + LivePipe)"
echo -e "     ${CYAN}live stop${NC}     - Stop all services"
echo -e "     ${CYAN}live status${NC}   - Check service status and permissions"
echo -e "     ${CYAN}live logs${NC}     - View real-time logs"
echo ""
read -p "Press Enter to grant sudo access and continue..."
echo ""

if [ -L "$BIN_LINK" ]; then
    sudo rm "$BIN_LINK"
fi

# Check if /usr/local/bin exists
if [ ! -d "/usr/local/bin" ]; then
    echo -e "${YELLOW}⚠  /usr/local/bin does not exist${NC}"
    sudo mkdir -p /usr/local/bin
fi

# Try to create symlink
if sudo ln -s "$INSTALL_DIR/bin/live" "$BIN_LINK" 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Command 'live' is now available globally"
    echo -e "   You can now run: ${CYAN}live start${NC}"
else
    echo -e "${YELLOW}⚠  Could not create global command${NC}"
    echo -e "${CYAN}→${NC} Add to your PATH manually: export PATH=\"\$HOME/.livepipe/bin:\$PATH\""
    echo -e "${CYAN}→${NC} Or use: $INSTALL_DIR/bin/live"
fi

# macOS permission reminder
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: macOS Permissions${NC}\n"
echo -e "Screenpipe requires ${CYAN}Screen Recording${NC} permission:"
echo "  1. Open System Settings"
echo "  2. Privacy & Security → Screen Recording"
echo "  3. Enable 'screenpipe' (start it first if not in list)"
echo ""
echo -e "For notifications to work, enable for your Terminal app:"
echo "  Privacy & Security → Notifications → Terminal (or iTerm/etc.)"
echo ""

# Success message
echo -e "${GREEN}🎉 LivePipe installed successfully!${NC}\n"
echo -e "${CYAN}📚 Available commands:${NC}\n"
echo "  live start          Start all services"
echo "  live stop           Stop all services"
echo "  live status         Show service status"
echo "  live logs [name]    View logs"
echo "  live restart        Restart services"
echo "  live update         Update to latest version"
echo "  live config         Edit configuration"
echo "  live help           Show help"
echo ""
echo -e "${CYAN}🚀 Get started:${NC}\n"
echo "  live start"
echo ""
echo -e "Dashboard: ${BLUE}http://localhost:3060${NC}"
echo ""
