#!/usr/bin/env python3
"""Opt-in real FTP transfer checks against a disposable loopback test server.

FREEISP_FTP_TEST_PASSWORD must be a throwaway password for the isolated fixture,
never a production router password. Starts no service and changes no accounts.
"""

import ftplib
import io
import os
import uuid


def connect():
    ftp = ftplib.FTP()
    ftp.connect("127.0.0.1", int(os.environ.get("FREEISP_FTP_TEST_PORT", "21210")), timeout=10)
    return ftp


def must_deny(action, message):
    try:
        action()
    except ftplib.error_perm:
        return
    raise AssertionError(message)


def main():
    password = os.environ["FREEISP_FTP_TEST_PASSWORD"]
    for username, rejected_password in [("anonymous", "test@example.invalid"), ("root", password + "-incorrect")]:
        with connect() as ftp:
            must_deny(lambda: ftp.login(username, rejected_password), "Unauthenticated login succeeded")

    payload = b"FreeISP FTP transfer test\x00\xff\r\n"
    with connect() as ftp:
        ftp.login("root", password)
        assert ftp.pwd() == "/", "Session is not at the confined root"
        must_deny(lambda: ftp.cwd("/etc"), "Router /etc is accessible")
        must_deny(lambda: ftp.storbinary("STOR /must-not-write", io.BytesIO(payload)), "Jail root is writable")
        ftp.cwd("/files")
        for passive in (True, False):
            ftp.set_pasv(passive)
            filename = "ftp-test-" + uuid.uuid4().hex + ".bin"
            created = False
            try:
                ftp.storbinary("STOR " + filename, io.BytesIO(payload))
                created = True
                assert filename in ftp.nlst(), "Uploaded file is missing from listing"
                received = io.BytesIO()
                ftp.retrbinary("RETR " + filename, received.write)
                assert received.getvalue() == payload, "Downloaded bytes differ"
                print(("Passive" if passive else "Active") + " login/list/upload/download: passed")
            finally:
                if created:
                    ftp.delete(filename)
        ftp.cwd("../..")
        assert ftp.pwd() == "/", "Traversal escaped the confined root"
        must_deny(lambda: ftp.retrbinary("RETR /../../etc/shadow", lambda _: None), "Traversal exposed system files")
    print("Anonymous and wrong-password rejection, root write protection and traversal confinement: passed")


if __name__ == "__main__":
    main()
