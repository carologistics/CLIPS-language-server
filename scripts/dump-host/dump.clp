;;; dump.clp - tells the CLIPS language server what your program defines.
;;;
;;; When CLIPS is embedded in a C/C++ (or other) program, that program
;;; usually defines things the .clp files use: functions registered with
;;; AddUDF, and constructs created with Build, LoadFromString or
;;; Eval("(build ...)"). The language server only reads .clp files, so it
;;; reports those names as unknown ("Unknown function distance", "Unknown
;;; deftemplate sensor", ...).
;;;
;;; This script asks the running program's CLIPS environment what it holds
;;; and writes it to a declaration file, host.clpd. The server reads that
;;; file and treats everything in it as defined: no more unknown-name
;;; warnings for those names, and calls to the program's functions get
;;; argument-count checks, hover and completion. Nothing is run by the
;;; server; the file is plain text.
;;;
;;; ===========================================================================
;;; HOW TO USE IT
;;; ===========================================================================
;;; 1. Keep this file where it is, or copy it next to your program. It has
;;;    no dependencies.
;;;
;;; 2. In your program, run it once, right AFTER your own AddUDF / Build /
;;;    LoadFromString / Eval calls and BEFORE you load the user's .clp
;;;    files:
;;;
;;;      Environment *env = CreateEnvironment();
;;;      AddUDF(env, "distance", "d", 4, 4, "ld", Distance, "Distance", NULL);
;;;      Build(env, "(deftemplate sensor (slot id) (slot value))");
;;;      ...
;;;      Build(env, "(defglobal ?*lsp-dump-file* = \"C:/project/rules/host.clpd\")");
;;;      BatchStar(env, "C:/path/to/dump.clp");      /* <- here */
;;;      Load(env, "rules.clp");                     /* user files after it */
;;;
;;;    The same lines work from C++ (CLIPS compiled as C++, possibly inside
;;;    a namespace: clips::BatchStar(...)). From another language, run the
;;;    CLIPS command (batch* "C:/path/to/dump.clp") through whatever eval
;;;    function its CLIPS binding offers. A program that gives you a CLIPS
;;;    prompt can also take the command there, at the same point.
;;;
;;;    Why the order matters: run later, the dump also contains the user's
;;;    own constructs, and keeps them "defined" after they are deleted from
;;;    the .clp files. The server then warns in host.clpd ("dump.clp ran
;;;    after the host loaded the user's .clp files").
;;;
;;;    Wrap the two dump lines in a debug flag or a command-line option if
;;;    you like; the program doesn't need the dump to run.
;;;
;;; 3. Choose where host.clpd goes:
;;;      - set the global ?*lsp-dump-file* to its full path before running
;;;        the script (use / in paths: \ is an escape character in a CLIPS
;;;        string), or
;;;      - leave it unset: the file is written as host.clpd in the
;;;        program's working directory.
;;;    Put it in the folder that holds the .clp files it describes. It
;;;    applies to the .clp files in that folder and all folders below it.
;;;    Several programs, or several environments of one program, with
;;;    different functions: one dump per environment, each in the folder of
;;;    its own .clp files.
;;;
;;; 4. Run the program once. The language server notices the new file by
;;;    itself. Run it again whenever the program's AddUDF/Build calls
;;;    change: a hover over a host function shows when the dump was made,
;;;    and unknown-name warnings say how old it is.
;;;
;;; 5. Don't edit host.clpd: the next run overwrites it. For what the dump
;;;    can't know, use a hand-written declaration file (externals.clpd in
;;;    the same folder). The server's quick fixes on an unknown name create
;;;    and fill it for you ("Declare ... as external").
;;;
;;; ===========================================================================
;;; LIMITATIONS
;;; ===========================================================================
;;; - Not instances or facts: they are data, not declarations.
;;; - Constructs CLIPS kept no text for (loaded with conserve-mem on, or
;;;   from a bload image) get a warning comment instead: declare those by
;;;   hand in externals.clpd.
;;; - Only what exists when the script runs: functions a program registers
;;;   later, or only in some configurations, are missing from that dump.
;;;
;;; Implementation note: everything runs inside deffunctions (a top-level
;;; bind does not survive to the next command of a batch file); all of them
;;; are removed again at the end, and every name starting with lsp-dump- is
;;; left out of the file.

;; Whether a name belongs to this script.
(deffunction lsp-dump-own (?name)
   (if (str-index "lsp-dump-" ?name) then TRUE else FALSE))

;; The output path: ?*lsp-dump-file* if defined, else host.clpd.
(deffunction lsp-dump-target ()
   (if (member$ lsp-dump-file (get-defglobal-list))
      then (eval "?*lsp-dump-file*")
      else "host.clpd"))

;; A number as at least two digits, for the timestamp.
(deffunction lsp-dump-pad (?n)
   (if (< ?n 10) then (str-cat "0" ?n) else (str-cat ?n)))

;; Writes a construct's text, or a warning comment when CLIPS kept none
;; (constructs loaded with conserve-mem on, or from a bload image).
(deffunction lsp-dump-emit (?kind ?name ?text)
   (if (neq ?text "")
      then (printout lsp-dump-out ?text crlf)
      else (printout lsp-dump-out ";; WARNING: no source text for " ?kind " " ?name
                     " (conserve-mem or bload) - declare it by hand" crlf crlf)))

;; (defudf <name> "*" <min> <max> "<argTypes>"), from get-function-restrictions,
;; which returns "<min>;<max>;<argTypes>". Internal names like
;; "(query-instance)" are skipped.
(deffunction lsp-dump-functions ()
   (progn$ (?f (get-function-list))
      (if (neq (sub-string 1 1 ?f) "(") then
         (bind ?r (get-function-restrictions ?f))
         (bind ?p (str-index ";" ?r))
         (bind ?min (sub-string 1 (- ?p 1) ?r))
         (bind ?r (sub-string (+ ?p 1) (str-length ?r) ?r))
         (bind ?p (str-index ";" ?r))
         (if ?p
            then (bind ?max (sub-string 1 (- ?p 1) ?r))
                 (bind ?args (sub-string (+ ?p 1) (str-length ?r) ?r))
            else (bind ?max ?r)
                 (bind ?args "*"))
         (printout lsp-dump-out "(defudf " ?f " \"*\" " ?min " " ?max " \"" ?args "\")" crlf)))
   (printout lsp-dump-out crlf))

;; Writes every construct except this script's own.
(deffunction lsp-dump-constructs ()
   ;; Modules first, so the module-qualified names below resolve.
   (progn$ (?m (get-defmodule-list))
      (bind ?s (ppdefmodule ?m nil))
      (if (and (neq ?m MAIN) (neq ?s "")) then (printout lsp-dump-out ?s crlf)))
   ;; Implied templates (ordered facts) need no declaration.
   (progn$ (?t (get-deftemplate-list *))
      (if (neq (deftemplate-slot-names ?t) (create$ implied)) then
         (lsp-dump-emit deftemplate ?t (ppdeftemplate ?t nil))))
   (progn$ (?g (get-defglobal-list *))
      (if (not (lsp-dump-own ?g)) then (lsp-dump-emit defglobal ?g (ppdefglobal ?g nil))))
   (progn$ (?d (get-deffunction-list *))
      (if (not (lsp-dump-own ?d)) then (lsp-dump-emit deffunction ?d (ppdeffunction ?d nil))))
   (progn$ (?g (get-defgeneric-list *))
      (lsp-dump-emit defgeneric ?g (ppdefgeneric ?g nil)))
   (bind ?m (get-defmethod-list))                       ; flat: name index name index ...
   (loop-for-count (?i 1 (div (length$ ?m) 2))
      (lsp-dump-emit defmethod (nth$ (- (* 2 ?i) 1) ?m)
                     (ppdefmethod (nth$ (- (* 2 ?i) 1) ?m) (nth$ (* 2 ?i) ?m) nil)))
   ;; Built-in classes and handlers have no text: skip them silently.
   (progn$ (?c (get-defclass-list *))
      (bind ?s (ppdefclass ?c nil))
      (if (neq ?s "") then (printout lsp-dump-out ?s crlf))
      (bind ?h (get-defmessage-handler-list ?c))        ; flat: class name type ...
      (loop-for-count (?i 1 (div (length$ ?h) 3))
         (bind ?s (ppdefmessage-handler (nth$ (- (* 3 ?i) 2) ?h)
                                        (nth$ (- (* 3 ?i) 1) ?h)
                                        (nth$ (* 3 ?i) ?h) nil))
         (if (neq ?s "") then (printout lsp-dump-out ?s crlf)))))

;; Writes the file: header, functions, constructs. FALSE if it can't be opened.
(deffunction lsp-dump-run ()
   (bind ?file (lsp-dump-target))
   (if (not (open ?file lsp-dump-out "w")) then
      (println "dump.clp: cannot write " ?file)
      (return FALSE))
   (bind ?t (local-time))                               ; year month day hour minute second ...
   (printout lsp-dump-out ";;; Generated by dump.clp on " (nth$ 1 ?t) "-" (lsp-dump-pad (nth$ 2 ?t))
             "-" (lsp-dump-pad (nth$ 3 ?t)) " " (lsp-dump-pad (nth$ 4 ?t)) ":"
             (lsp-dump-pad (nth$ 5 ?t)) ":" (lsp-dump-pad (nth$ 6 ?t))
             " - do not edit by hand, run dump.clp again instead" crlf crlf)
   (lsp-dump-functions)
   (lsp-dump-constructs)
   (close lsp-dump-out)
   TRUE)

(lsp-dump-run)

(undeffunction lsp-dump-run)
(undeffunction lsp-dump-constructs)
(undeffunction lsp-dump-functions)
(undeffunction lsp-dump-emit)
(undeffunction lsp-dump-pad)
(undeffunction lsp-dump-target)
(undeffunction lsp-dump-own)
