#!/bin/bash
# Root directories shared by bin/liaison and ./setup. Sourced, never executed.
# Needs LIAISON_REPO (the checkout). LIAISON_HOME is where the bridge keeps its data (default ~/.liaison);
# LIAISON_OFFICE is the folder the coordinator runs in (default: the checkout); LIAISON_STATE_DIR holds setup state.
export LIAISON_REPO
export LIAISON_HOME="${LIAISON_HOME:-$HOME/.liaison}"
export LIAISON_OFFICE="${LIAISON_OFFICE:-$LIAISON_REPO}"
export LIAISON_STATE_DIR="${LIAISON_STATE_DIR:-$LIAISON_OFFICE/.liaison}"
