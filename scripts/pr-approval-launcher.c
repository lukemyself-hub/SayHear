#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef PR_APPROVAL_MODE
#error PR_APPROVAL_MODE must select a fixed controller command
#endif

static const char *runtime_node =
    "/Library/Application Support/SayHear/PRApproval/node";
static const char *controller_script =
    "/Library/Application Support/SayHear/PRApproval/controller.mjs";

#if PR_APPROVAL_MODE == 1
static const char *controller_command = "status";
static const char *launcher_name = "pr-approval-status";
#elif PR_APPROVAL_MODE == 2
static const char *controller_command = "prepare";
static const char *launcher_name = "pr-approval-prepare";
#elif PR_APPROVAL_MODE == 3
static const char *controller_command = "submit";
static const char *launcher_name = "pr-approval-submit";
#elif PR_APPROVAL_MODE == 4
static const char *controller_command = "configure";
static const char *launcher_name = "pr-approval-configure";
#elif PR_APPROVAL_MODE == 5
static const char *controller_command = "scan";
static const char *launcher_name = "pr-approval-scan";
#else
#error Unsupported PR_APPROVAL_MODE
#endif

#if PR_APPROVAL_MODE == 2 || PR_APPROVAL_MODE == 4 || PR_APPROVAL_MODE == 5
static int is_positive_decimal(const char *value) {
  if (value == NULL || value[0] == '\0' || value[0] == '0') return 0;
  for (const unsigned char *cursor = (const unsigned char *)value;
       *cursor != '\0'; cursor += 1) {
    if (!isdigit(*cursor)) return 0;
  }
  return 1;
}
#endif

#if PR_APPROVAL_MODE == 3
static int is_report_path(const char *path) {
  static const char *prefix = "artifacts/pr-approval/reports/";
  static const char *suffix = ".json";
  const size_t prefix_length = strlen(prefix);
  const size_t path_length = path == NULL ? 0 : strlen(path);
  if (path_length <= prefix_length + strlen(suffix) ||
      strncmp(path, prefix, prefix_length) != 0 ||
      strcmp(path + path_length - strlen(suffix), suffix) != 0) {
    return 0;
  }

  const char *component = path + prefix_length;
  const char *cursor = component;
  while (*cursor != '\0') {
    const unsigned char character = (unsigned char)*cursor;
    if (character < 0x21 || character == 0x7f || character == '\\') return 0;
    if (*cursor == '/') {
      const size_t component_length = (size_t)(cursor - component);
      if (component_length == 0 ||
          (component_length == 1 && component[0] == '.') ||
          (component_length == 2 && component[0] == '.' && component[1] == '.')) {
        return 0;
      }
      component = cursor + 1;
    }
    cursor += 1;
  }
  const size_t final_length = (size_t)(cursor - component);
  return final_length > 0 &&
         !(final_length == 1 && component[0] == '.') &&
         !(final_length == 2 && component[0] == '.' && component[1] == '.');
}
#endif

static int valid_arguments(int argc, char **argv) {
#if PR_APPROVAL_MODE == 1
  (void)argv;
  return argc == 1;
#elif PR_APPROVAL_MODE == 2
  return argc == 1 ||
         (argc == 3 && strcmp(argv[1], "--pr") == 0 &&
          is_positive_decimal(argv[2]));
#elif PR_APPROVAL_MODE == 3
  return argc == 3 && strcmp(argv[1], "--report") == 0 &&
         is_report_path(argv[2]);
#elif PR_APPROVAL_MODE == 4
  return argc == 11 && strcmp(argv[1], "--app-id") == 0 &&
         is_positive_decimal(argv[2]) &&
         strcmp(argv[3], "--installation-id") == 0 &&
         is_positive_decimal(argv[4]) && strcmp(argv[5], "--slug") == 0 &&
         argv[6][0] != '\0' &&
         strcmp(argv[7], "--production-merge-authorized") == 0 &&
         (strcmp(argv[8], "true") == 0 || strcmp(argv[8], "false") == 0) &&
         strcmp(argv[9], "--ordinary-merge-triggers-production") == 0 &&
         (strcmp(argv[10], "true") == 0 || strcmp(argv[10], "false") == 0);
#elif PR_APPROVAL_MODE == 5
  return argc == 1 ||
         (argc == 3 && strcmp(argv[1], "--pr") == 0 &&
          is_positive_decimal(argv[2]));
#endif
}

int main(int argc, char **argv) {
  if (!valid_arguments(argc, argv)) {
    fprintf(stderr, "%s received unsupported arguments.\n", launcher_name);
    return 64;
  }

  char **node_argv = calloc((size_t)argc + 3, sizeof(char *));
  if (node_argv == NULL) {
    perror("calloc");
    return 127;
  }
  node_argv[0] = (char *)runtime_node;
  node_argv[1] = (char *)controller_script;
  node_argv[2] = (char *)controller_command;
  for (int index = 1; index < argc; index += 1) {
    node_argv[index + 2] = argv[index];
  }

  char *const clean_environment[] = {
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "TMPDIR=/private/tmp",
      NULL,
  };
  execve(runtime_node, node_argv, clean_environment);
  perror("execve");
  return 127;
}
