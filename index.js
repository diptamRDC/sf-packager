#!/usr/bin/env node

/**
 * CLI tool to parse git diff and build a package.xml file from it.
 * This is useful for using the MavensMate deployment tool and selecting the existing package.xml file
 * Also used in larger orgs to avoid deploying all metadata in automated deployments
 *
 * usage:
 *  $ sfpackage master featureBranch ./deploy/
 *
 *  This will create a file at ./deploy/featureBranch/unpackaged/package.xml
 *  and copy each metadata item into a matching folder.
 *  Also if any deletes occurred it will create a file at ./deploy/featureBranch/destructive/destructiveChanges.xml
 */
const program = require("commander");
const spawnSync = require("child_process").spawnSync;
const packageWriter = require("./lib/metaUtils").packageWriter;
const buildPackageDir = require("./lib/metaUtils").buildPackageDir;
const copyFiles = require("./lib/metaUtils").copyFiles;
const packageVersion = require("./package.json").version;

program
  .arguments("<compare> <branch> [target]")
  .version(packageVersion)
  .option(
    "-d, --dryrun",
    "Only print the package.xml and destructiveChanges.xml that would be generated"
  )
  .option(
    "-p, --pversion [version]",
    "Salesforce version of the package.xml",
    parseInt
  )
  .action(function (compare, branch, target) {
    if (!branch || !compare) {
      console.error("branch and target branch are both required");
      program.help();
      process.exit(1);
    }

    const dryrun = program.dryrun;

    if (!dryrun && !target) {
      console.error("target required when not dry-run");
      program.help();
      process.exit(1);
    }

    const currentDir = process.cwd();
    const gitDiff = spawnSync("git", [
      "diff",
      "--name-status",
      compare,
      branch,
    ]);
    const gitDiffStdOut = gitDiff.stdout.toString();
    const gitDiffStdErr = gitDiff.stderr.toString();

    if (gitDiffStdErr) {
      console.error("An error has occurred: %s", gitDiffStdErr);
      process.exit(1);
    }

    let fileListForCopy = [];

    //defines the different member types
    const metaBag = {};
    const metaBagDestructive = {};
    let deletesHaveOccurred = false;

    const fileList = gitDiffStdOut.split("\n");
    fileList.forEach(function (fileName) {
      // get the git operation
      const operation = fileName.slice(0, 1);
      // remove the operation and spaces from fileName
      console.log("operation", operation);
      fileName = fileName.slice(1).trim();

      //ensure file is inside of src directory of project
      if (fileName && fileName.indexOf("force-app") > -1) {
        //ignore changes to the package.xml file
        if (fileName === "src/package.xml") {
          return;
        }

        const parts = fileName.split("/");
        // Check for invalid fileName, likely due to data stream exceeding buffer size resulting in incomplete string
        // TODO: need a way to ensure that full fileNames are processed - increase buffer size??
        if (parts[2] === undefined) {
          console.error(
            'File name "%s" cannot be processed, exiting',
            fileName
          );
          process.exit(1);
        }

        let meta;

        if (parts.length === 4) {
          // Processing metadata with nested folders e.g. emails, documents, reports
          meta = parts[3] + "/" + parts[4].split(".")[0];
        } else {
          // Processing metadata without nested folders. Strip -meta from the end.
          meta = parts[4].split(".")[0].replace("-meta", "");
        }
        if (operation === "A" || operation === "M") {
          // file was added or modified - add fileName to array for unpackaged and to be copied
          console.log("File was added or modified: %s", fileName);
          fileListForCopy.push(fileName);

          if (!metaBag.hasOwnProperty(parts[3])) {
            metaBag[parts[3]] = [];
          }
          if (metaBag[parts[3]].indexOf(meta) === -1) {
            metaBag[parts[3]].push(meta);
          }
        } else if (operation === "D") {
          // file was deleted
          console.log("File was deleted: %s", fileName);
          deletesHaveOccurred = true;

          if (!metaBagDestructive.hasOwnProperty(parts[1])) {
            metaBagDestructive[parts[1]] = [];
          }

          if (metaBagDestructive[parts[1]].indexOf(meta) === -1) {
            metaBagDestructive[parts[1]].push(meta);
          }
        } else {
          // situation that requires review
          return console.error("Operation on file needs review: %s", fileName);
        }
      }
    });

    // build package file content
    const packageXML = packageWriter(metaBag, program.pversion);
    // build destructiveChanges file content
    const destructiveXML = packageWriter(metaBagDestructive, program.pversion);
    if (dryrun) {
      console.log("\npackage.xml\n");
      console.log(packageXML);
      console.log("\ndestructiveChanges.xml\n");
      console.log(destructiveXML);
      process.exit(0);
    }

    console.log("Building in directory %s", target);

    buildPackageDir(
      target,
      branch,
      metaBag,
      packageXML,
      false,
      (err, buildDir) => {
        if (err) {
          return console.error(err);
        }

        copyFiles(currentDir, buildDir, fileListForCopy);
        console.log(
          "Successfully created package.xml and files in %s",
          buildDir
        );
      }
    );

    if (deletesHaveOccurred) {
      buildPackageDir(
        target,
        branch,
        metaBagDestructive,
        destructiveXML,
        true,
        (err, buildDir) => {
          if (err) {
            return console.error(err);
          }

          console.log(
            "Successfully created destructiveChanges.xml in %s",
            buildDir
          );
        }
      );
    }
  });

program.parse(process.argv);
