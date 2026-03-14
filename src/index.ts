#!/usr/bin/env node
import {runCommand} from "./cli/commands.ts";

await runCommand(process.argv.slice(2));
