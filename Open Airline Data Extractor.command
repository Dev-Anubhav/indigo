#!/bin/zsh

PROJECT_DIR="/Users/user/Downloads/indigo-scraper-v2"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project folder not found: $PROJECT_DIR"
  echo "Please move the project back to Downloads/indigo-scraper-v2 or update this script path."
  read -k 1 "?Press any key to close..."
  echo
  exit 1
fi

cd "$PROJECT_DIR" || exit 1

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ ! -d "node_modules/electron" ]; then
  echo "Installing Electron..."
  npm install electron
fi

if [ ! -d "node_modules/electron-builder" ]; then
  echo "Installing electron-builder..."
  npm install -D electron-builder
fi

export WEB_HOST=127.0.0.1
export WEB_PORT=8787

npm run desktop
