export default {
  scripts: {
    // bun manages node_modules for this project; Hutch only builds and runs the desktop shell.
    dev: ["hutch", "electrobun", "dev"],
    build: ["hutch", "electrobun", "build", "--env=stable"],
  },
  electrobun: {
    version: "2.0.1",
  },
};
